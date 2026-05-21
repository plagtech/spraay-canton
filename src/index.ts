// Spraay Canton — Main Entry Point
//
// Boots the Express API server and connects to the Canton participant
// node via the JSON Ledger API. Run with:
//
//   npm run dev        — development (ts-node)
//   npm start          — production (compiled)
//   npm run mcp:start  — MCP server mode (stdio)

import { config } from "./config";
import { CantonLedgerClient } from "./canton/ledger-client";
import { RegistryClient } from "./canton/registry-client";
import { createApiServer } from "./api/server";
import { logger } from "./utils/logger";

async function main(): Promise<void> {
  logger.info("=== Spraay Canton v0.1.0 ===");
  logger.info(`Network: ${config.network}`);
  logger.info(`Ledger API: ${config.canton.ledgerApiUrl}`);
  logger.info(`Scan URL: ${config.canton.scanUrl}`);
  logger.info(`Fee rate: ${config.spraay.feeRate * 100}%`);
  logger.info(`Max batch size: ${config.spraay.maxBatchSize}`);

  // Connect to Canton
  const ledger = new CantonLedgerClient();
  const registry = new RegistryClient(config.canton.scanUrl);

  // Health check — Ledger API
  const healthy = await ledger.isHealthy();
  if (healthy) {
    logger.info("Canton participant node: connected");
    try {
      const offset = await ledger.getLedgerEnd();
      logger.info(`Ledger end offset: ${offset}`);
    } catch {
      logger.warn("Could not query ledger end (may need auth)");
    }
  } else {
    logger.warn(
      "Canton participant node: unreachable — start sandbox with `npm run sandbox`"
    );
  }

  // Health check — Registry (Scan app)
  const registryUp = await registry.isAvailable();
  if (registryUp) {
    logger.info("Token Standard registry (Scan): connected");
  } else {
    logger.warn(
      "Token Standard registry (Scan): unreachable — transfers will fail. " +
        "Ensure cn-quickstart or a validator with Scan is running."
    );
  }

  // Ensure operator party exists (dev/sandbox only)
  if (!config.canton.operatorPartyId && config.network === "localnet") {
    logger.info("No operator party configured, allocating one...");
    try {
      const party = await ledger.allocateParty("spraay-operator");
      logger.info(`Allocated operator party: ${party.party}`);
      logger.info("Set SPRAAY_OPERATOR_PARTY_ID in .env to persist this");
      // Store in runtime config (won't survive restart without .env)
      (config.canton as any).operatorPartyId = party.party;
    } catch (error) {
      logger.warn("Could not allocate operator party (Canton may not be running)");
    }
  }

  // Start API server
  const app = createApiServer(ledger, registry);
  app.listen(config.server.port, config.server.host, () => {
    logger.info(`API server listening on ${config.server.host}:${config.server.port}`);
    logger.info("Endpoints:");
    logger.info(`  GET  /health`);
    logger.info(`  GET  /.well-known/spraay`);
    logger.info(`  POST /api/v1/batch`);
    logger.info(`  GET  /api/v1/batch/:batchId`);
    logger.info(`  GET  /api/v1/holdings/:partyId`);
    logger.info(`  POST /api/v1/parties`);
  });
}

main().catch((error) => {
  logger.error("Fatal:", error);
  process.exit(1);
});
