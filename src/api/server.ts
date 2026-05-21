// Spraay Canton — REST API Server
//
// Exposes batch payment endpoints compatible with the Spraay gateway
// pattern. Can be called directly or proxied through the main
// gateway.spraay.app x402 gateway.

import express from "express";
import cors from "cors";
import { config } from "../config";
import { CantonLedgerClient } from "../canton/ledger-client";
import { RegistryClient } from "../canton/registry-client";
import { BatchOrchestrator, BatchPaymentInput } from "../batch/orchestrator";
import { logger } from "../utils/logger";

export function createApiServer(
  ledger: CantonLedgerClient,
  registry?: RegistryClient
): express.Express {
  const app = express();
  const orchestrator = new BatchOrchestrator(ledger, registry);

  app.use(cors());
  app.use(express.json());

  // -------------------------------------------------------------------------
  // Health & Discovery
  // -------------------------------------------------------------------------

  app.get("/health", async (_req, res) => {
    const cantonHealthy = await ledger.isHealthy();
    res.json({
      service: "spraay-canton",
      version: "0.1.0",
      canton: cantonHealthy ? "connected" : "unreachable",
      network: config.network,
      operator: config.canton.operatorPartyId || "not-configured",
    });
  });

  app.get("/.well-known/spraay", (_req, res) => {
    res.json({
      protocol: "spraay-canton",
      version: "0.1.0",
      chain: "canton-network",
      capabilities: ["batch-transfer", "utxo-merge", "activity-rewards"],
      feeRate: config.spraay.feeRate,
      maxBatchSize: config.spraay.maxBatchSize,
      supportedInstruments: ["CantonCoin", "USDCx"],
      tokenStandard: "CIP-0056",
    });
  });

  // -------------------------------------------------------------------------
  // Batch Payments
  // -------------------------------------------------------------------------

  /**
   * POST /api/v1/batch
   *
   * Submit a batch payment request.
   *
   * Body:
   * {
   *   "senderPartyId": "Alice::1220abc...",
   *   "recipients": [
   *     { "partyId": "Bob::1220def...", "amount": 10.5, "memo": "Payment 1" },
   *     { "partyId": "Carol::1220ghi...", "amount": 5.0 }
   *   ],
   *   "instrument": "CantonCoin"
   * }
   */
  app.post("/api/v1/batch", async (req, res) => {
    try {
      const input: BatchPaymentInput = req.body;

      // Validation
      if (!input.senderPartyId) {
        return res.status(400).json({ error: "senderPartyId is required" });
      }
      if (!input.recipients || input.recipients.length === 0) {
        return res.status(400).json({ error: "At least one recipient is required" });
      }
      if (input.recipients.length > config.spraay.maxBatchSize) {
        return res.status(400).json({
          error: `Batch size ${input.recipients.length} exceeds max ${config.spraay.maxBatchSize}`,
        });
      }
      if (!input.instrument) {
        return res.status(400).json({ error: "instrument is required" });
      }

      // Validate amounts
      for (const r of input.recipients) {
        if (!r.partyId || r.amount <= 0) {
          return res.status(400).json({
            error: `Invalid recipient: ${JSON.stringify(r)}`,
          });
        }
      }

      const result = await orchestrator.executeBatch(input);
      const statusCode = result.status === "failed" ? 422 : 200;
      res.status(statusCode).json(result);
    } catch (error: any) {
      logger.error("Batch API error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // -------------------------------------------------------------------------
  // Holdings Query (read-only)
  // -------------------------------------------------------------------------

  /**
   * GET /api/v1/holdings/:partyId
   *
   * Query a party's token holdings (UTXO list).
   */
  app.get("/api/v1/holdings/:partyId", async (req, res) => {
    try {
      const { partyId } = req.params;
      const instrument = req.query.instrument as string | undefined;

      const events = await ledger.getContractsByInterface(
        partyId,
        "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding"
      );

      const holdings = events.map((e) => {
        const view = e.interfaceViews?.find((v) =>
          v.interfaceId.includes("HoldingV1:Holding")
        )?.viewValue;

        return {
          contractId: e.contractId,
          amount: view?.amount || e.createArgument?.amount,
          owner: view?.owner || e.createArgument?.owner,
          instrument: view?.instrument || e.createArgument?.instrument,
        };
      });

      const filtered = instrument
        ? holdings.filter((h) => String(h.instrument) === instrument)
        : holdings;

      res.json({
        partyId,
        utxoCount: filtered.length,
        totalBalance: filtered.reduce(
          (sum, h) => sum + parseFloat(String(h.amount || 0)),
          0
        ),
        holdings: filtered,
        needsMerging: filtered.length > config.spraay.maxUtxoTarget,
      });
    } catch (error: any) {
      logger.error("Holdings query error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // -------------------------------------------------------------------------
  // Batch Receipt Query
  // -------------------------------------------------------------------------

  /**
   * GET /api/v1/batch/:batchId
   *
   * Look up a batch payment receipt.
   */
  app.get("/api/v1/batch/:batchId", async (req, res) => {
    try {
      const { batchId } = req.params;

      const receipts = await ledger.getActiveContracts(
        config.canton.operatorPartyId,
        "#spraay-canton:Spraay.BatchPayment:BatchPaymentReceipt"
      );

      const receipt = receipts.find(
        (r) => (r.createArgument as any).batchId === batchId
      );

      if (!receipt) {
        return res.status(404).json({ error: "Batch not found" });
      }

      res.json(receipt.createArgument);
    } catch (error: any) {
      logger.error("Receipt query error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // -------------------------------------------------------------------------
  // Party Management (dev/sandbox convenience)
  // -------------------------------------------------------------------------

  app.post("/api/v1/parties", async (req, res) => {
    try {
      const { hint } = req.body;
      const party = await ledger.allocateParty(hint || "spraay-user");
      res.json(party);
    } catch (error: any) {
      logger.error("Party allocation error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  return app;
}
