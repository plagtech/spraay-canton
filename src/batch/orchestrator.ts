// Spraay Canton — Batch Payment Orchestrator
//
// Coordinates the full lifecycle of a batch payment:
//   1. Accept batch request from API/MCP
//   2. Create BatchPaymentRequest contract on-ledger
//   3. Query sender's Holding UTXOs via Token Standard interface
//   4. Select optimal UTXOs (small-first strategy)
//   5. Construct TransferFactory_Transfer commands for each recipient
//   6. Submit commands to Canton Ledger API
//   7. Mark execution complete, create activity marker for CC rewards
//
// The orchestrator uses Canton's command deduplication (commandId) for
// idempotency and retries on retryable errors per Canton best practices.

import { v4 as uuid } from "uuid";
import { CantonLedgerClient, DisclosedContract } from "../canton/ledger-client";
import { RegistryClient, TransferFactoryInfo } from "../canton/registry-client";
import { config, DAML_IDS } from "../config";
import { selectUtxos, parseHoldings, HoldingUtxo } from "./utxo-selection";
import { logger } from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BatchPaymentInput {
  senderPartyId: string;
  recipients: Array<{
    partyId: string;
    amount: number;
    memo?: string;
  }>;
  instrument: string; // e.g. "CantonCoin", "USDCx"
}

export interface BatchPaymentResult {
  batchId: string;
  status: "completed" | "partial" | "failed";
  totalRecipients: number;
  completedTransfers: number;
  failedTransfers: number;
  totalAmount: number;
  feeCharged: number;
  feeCollected?: boolean;
  ledgerOffset?: number;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class BatchOrchestrator {
  private ledger: CantonLedgerClient;
  private registry: RegistryClient;
  private operatorParty: string;

  constructor(ledger: CantonLedgerClient, registry?: RegistryClient) {
    this.ledger = ledger;
    this.registry = registry || new RegistryClient();
    this.operatorParty = config.canton.operatorPartyId;
  }

  /**
   * Execute a batch payment end-to-end.
   *
   * This is the main entry point called by the API server and MCP tools.
   */
  async executeBatch(input: BatchPaymentInput): Promise<BatchPaymentResult> {
    const batchId = `spraay-batch-${uuid()}`;
    logger.info(`Starting batch ${batchId}: ${input.recipients.length} recipients on ${input.instrument}`);

    try {
      // Step 1: Calculate totals
      const totalAmount = input.recipients.reduce((sum, r) => sum + r.amount, 0);
      const fee = totalAmount * config.spraay.feeRate;
      const totalNeeded = totalAmount + fee;

      // Step 2: Query sender's holdings via Token Standard Holding interface
      const holdingEvents = await this.ledger.getContractsByInterface(
        input.senderPartyId,
        DAML_IDS.tokenStandard.holding
      );
      const holdings = parseHoldings(holdingEvents);

      logger.info(`Sender has ${holdings.length} Holding UTXOs, total: ${holdings.reduce((s, h) => s + h.amount, 0)}`);

      // Step 3: Select optimal UTXOs
      const selection = selectUtxos(holdings, totalNeeded);
      if (!selection.sufficient) {
        return {
          batchId,
          status: "failed",
          totalRecipients: input.recipients.length,
          completedTransfers: 0,
          failedTransfers: input.recipients.length,
          totalAmount,
          feeCharged: 0,
        };
      }

      // Step 4: Create BatchPaymentRequest on-ledger
      const requestResult = await this.createBatchRequest(batchId, input);
      logger.info(`BatchPaymentRequest created at offset ${requestResult}`);

      // Step 5: Execute transfers via Token Standard TransferFactory
      const transferResults = await this.executeTransfers(
        batchId,
        input,
        selection.selected
      );

      // Step 5b: Collect the 0.3% protocol fee → Spraay operator party
      const completed = transferResults.filter((r) => r.success).length;
      const failed = transferResults.filter((r) => !r.success).length;
      let feeCollected = false;

      if (completed > 0 && fee > 0) {
        feeCollected = await this.collectProtocolFee(
          batchId,
          input.senderPartyId,
          input.instrument,
          fee
        );
        if (!feeCollected) {
          logger.warn(
            `Fee collection failed for batch ${batchId} — ` +
              `${fee} ${input.instrument} not transferred to operator`
          );
        }
      }

      // Step 6: Mark completion on-ledger
      await this.markBatchCompleted(batchId, completed, failed, totalAmount, feeCollected ? fee : 0);

      // Step 7: Create activity marker for CC rewards
      if (completed > 0) {
        await this.createActivityMarker(batchId, input.instrument, completed, totalAmount);
      }

      const status = failed === 0 ? "completed" : completed > 0 ? "partial" : "failed";
      logger.info(`Batch ${batchId} ${status}: ${completed}/${input.recipients.length} transfers`);

      return {
        batchId,
        status,
        totalRecipients: input.recipients.length,
        completedTransfers: completed,
        failedTransfers: failed,
        totalAmount,
        feeCharged: feeCollected ? fee : 0,
        feeCollected,
      };
    } catch (error) {
      logger.error(`Batch ${batchId} failed:`, error);
      return {
        batchId,
        status: "failed",
        totalRecipients: input.recipients.length,
        completedTransfers: 0,
        failedTransfers: input.recipients.length,
        totalAmount: 0,
        feeCharged: 0,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Create the BatchPaymentRequest Daml contract
  // -------------------------------------------------------------------------

  private async createBatchRequest(
    batchId: string,
    input: BatchPaymentInput
  ): Promise<number> {
    const payments = input.recipients.map((r) => ({
      recipient: r.partyId,
      amount: String(r.amount),
      memo: r.memo ? { Some: r.memo } : "None",
    }));

    const result = await this.ledger.createContract(
      DAML_IDS.templates.batchRequest,
      {
        sender: input.senderPartyId,
        operator: this.operatorParty,
        payments,
        instrument: input.instrument,
        batchId,
        createdAt: new Date().toISOString(),
      },
      [input.senderPartyId],
      `create-batch-${batchId}`
    );

    return result.completionOffset;
  }

  // -------------------------------------------------------------------------
  // Step 5: Execute individual transfers via TransferFactory
  //
  // Flow per Canton Token Standard docs + CLI reference:
  //   a) Fetch TransferFactory from registry (Scan app) — once per batch
  //   b) For each recipient: build ExerciseCommand with:
  //      - templateId: TransferFactory interface ID
  //      - contractId: factoryId from registry
  //      - choice: "TransferFactory_Transfer"
  //      - choiceArgument: sender, receiver, amount, inputHoldingCids, meta
  //      - disclosedContracts: from registry + sender's holding blobs
  //   c) Submit via Ledger API submit-and-wait
  //   d) After each transfer, re-query holdings for updated UTXO set
  //      (previous UTXOs are consumed, new change UTXOs created)
  // -------------------------------------------------------------------------

  private async executeTransfers(
    batchId: string,
    input: BatchPaymentInput,
    selectedUtxos: HoldingUtxo[]
  ): Promise<Array<{ recipientParty: string; success: boolean; error?: string }>> {
    const results: Array<{ recipientParty: string; success: boolean; error?: string }> = [];

    // (a) Fetch the TransferFactory once — it's the same for all transfers
    //     of the same instrument. The registry returns the factory contract
    //     ID, disclosed contracts (for explicit disclosure), and the choice
    //     context data that Canton needs to validate the transfer.
    let factory: TransferFactoryInfo;
    try {
      factory = await this.registry.getTransferFactory();
      logger.info(`TransferFactory fetched: ${factory.factoryId.substring(0, 16)}...`);
    } catch (error: any) {
      logger.error(`Registry unreachable — cannot execute transfers: ${error.message}`);
      return input.recipients.map((r) => ({
        recipientParty: r.partyId,
        success: false,
        error: `Registry unavailable: ${error.message}`,
      }));
    }

    // Track current holding CIDs — these change after each transfer
    // because Canton's UTXO model consumes inputs and creates new outputs
    let currentHoldingCids = selectedUtxos.map((u) => u.contractId);

    // Build disclosed contracts: registry's + sender's holding blobs
    const holdingDisclosed: DisclosedContract[] = selectedUtxos
      .filter((u) => u.createdEventBlob)
      .map((u) => ({
        templateId: DAML_IDS.tokenStandard.holding,
        contractId: u.contractId,
        createdEventBlob: u.createdEventBlob!,
      }));

    // (b) Execute transfers sequentially
    //     Canton recommends sequential for operations touching the same
    //     holdings to avoid contention. Each transfer consumes UTXOs and
    //     produces new ones (change), so we refresh between transfers.
    for (let i = 0; i < input.recipients.length; i++) {
      const recipient = input.recipients[i];
      const commandId = `${batchId}-xfer-${i}-${Date.now()}`;
      const now = new Date().toISOString();
      const executeBefore = new Date(
        Date.now() + 24 * 60 * 60 * 1000
      ).toISOString();

      try {
        // Build the choice argument matching Canton Token Standard schema
        // Reference: splice/token-standard/cli/src/commands/transfer.ts
        const choiceArgument = {
          // The instrument admin party — for Canton Coin this is the DSO party
          // For custom tokens, this comes from the token metadata registry
          expectedAdmin:
            config.canton.instrumentAdmin || config.canton.operatorPartyId,
          transfer: {
            sender: input.senderPartyId,
            receiver: recipient.partyId,
            amount: String(recipient.amount),
            instrumentId: {
              admin:
                config.canton.instrumentAdmin || config.canton.operatorPartyId,
              id: input.instrument,
            },
            lock: null,
            requestedAt: now,
            executeBefore,
            inputHoldingCids: currentHoldingCids,
            meta: {
              values: {
                "splice.lfdecentralizedtrust.org/tx-kind": "transfer",
                "splice.lfdecentralizedtrust.org/sender": input.senderPartyId,
                "splice.lfdecentralizedtrust.org/reason":
                  recipient.memo ||
                  `Spraay batch ${batchId} [${i + 1}/${input.recipients.length}]`,
              },
            },
          },
          context: factory.choiceContextData,
          extraArgs: {},
        };

        // Merge disclosed contracts: registry factory + sender holdings
        const allDisclosed = [
          ...factory.disclosedContracts,
          ...holdingDisclosed,
        ];

        // (c) Submit the transfer
        const result = await this.ledger.exerciseChoice(
          DAML_IDS.tokenStandard.transferFactory,
          factory.factoryId,
          "TransferFactory_Transfer",
          choiceArgument,
          [input.senderPartyId],
          commandId,
          allDisclosed
        );

        results.push({ recipientParty: recipient.partyId, success: true });
        logger.info(
          `Transfer ${i + 1}/${input.recipients.length} → ${recipient.partyId}: ` +
            `${recipient.amount} ${input.instrument} (offset ${result.completionOffset})`
        );

        // (d) After each transfer, refresh the sender's holdings because
        //     the previous UTXOs were consumed and new change UTXOs created.
        //     We need the updated CIDs for the next transfer in the batch.
        if (i < input.recipients.length - 1) {
          try {
            const freshHoldings = await this.ledger.getContractsByInterface(
              input.senderPartyId,
              DAML_IDS.tokenStandard.holding
            );
            currentHoldingCids = freshHoldings.map((h) => h.contractId);

            // Refresh disclosed contracts with new holding blobs
            holdingDisclosed.length = 0;
            freshHoldings
              .filter((h) => h.createdEventBlob)
              .forEach((h) =>
                holdingDisclosed.push({
                  templateId: DAML_IDS.tokenStandard.holding,
                  contractId: h.contractId,
                  createdEventBlob: h.createdEventBlob!,
                })
              );

            logger.debug(
              `Refreshed holdings: ${currentHoldingCids.length} UTXOs available`
            );
          } catch (refreshError: any) {
            logger.warn(
              `Holdings refresh failed after transfer ${i + 1}, ` +
                `continuing with stale CIDs: ${refreshError.message}`
            );
          }
        }
      } catch (error: any) {
        results.push({
          recipientParty: recipient.partyId,
          success: false,
          error: error.message,
        });
        logger.warn(
          `Transfer ${i + 1} → ${recipient.partyId} FAILED: ${error.message}`
        );

        // On transfer failure, still refresh holdings — the failed tx
        // may have partially consumed UTXOs depending on the error type
        try {
          const freshHoldings = await this.ledger.getContractsByInterface(
            input.senderPartyId,
            DAML_IDS.tokenStandard.holding
          );
          currentHoldingCids = freshHoldings.map((h) => h.contractId);
        } catch {
          // Continue with stale CIDs
        }
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Step 6: Mark batch completed on-ledger
  // -------------------------------------------------------------------------

  private async markBatchCompleted(
    batchId: string,
    completed: number,
    failed: number,
    totalAmount: number,
    fee: number
  ): Promise<void> {
    // Find the active BatchPaymentExecution contract
    const execContracts = await this.ledger.getActiveContracts(
      this.operatorParty,
      DAML_IDS.templates.batchExecution
    );

    const execContract = execContracts.find(
      (c) => (c.createArgument as any).batchId === batchId
    );

    if (execContract) {
      await this.ledger.exerciseChoice(
        DAML_IDS.templates.batchExecution,
        execContract.contractId,
        "MarkCompleted",
        {
          completed,
          failed,
          totalAmt: String(totalAmount),
          fee: String(fee),
        },
        [this.operatorParty],
        `mark-completed-${batchId}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 7: Create FeaturedAppActivityMarker for CC rewards
  // -------------------------------------------------------------------------

  private async createActivityMarker(
    batchId: string,
    instrument: string,
    numTransfers: number,
    totalVolume: number
  ): Promise<void> {
    try {
      await this.ledger.createContract(
        DAML_IDS.templates.activityMarker,
        {
          operator: this.operatorParty,
          batchId,
          instrument,
          numTransfers,
          totalVolume: String(totalVolume),
          timestamp: new Date().toISOString(),
        },
        [this.operatorParty],
        `activity-marker-${batchId}`
      );
      logger.info(`Activity marker created for batch ${batchId} (${numTransfers} transfers)`);
    } catch (error) {
      // Non-fatal — reward tracking failure shouldn't break batch execution
      logger.warn(`Failed to create activity marker for ${batchId}:`, error);
    }
  }

  // -------------------------------------------------------------------------
  // Step 5b: Collect Spraay protocol fee (0.3%)
  //
  // Executes a TransferFactory_Transfer from the sender to the Spraay
  // operator party for the fee amount. This is the actual revenue
  // collection — the operator party holds the collected fees as
  // Canton Coin / USDCx in its Holding UTXOs.
  //
  // The operator party IS the fee wallet. On Canton, parties hold
  // tokens directly — no separate wallet creation needed. The party
  // allocated as `spraay-operator` receives and accumulates fees.
  // -------------------------------------------------------------------------

  private async collectProtocolFee(
    batchId: string,
    senderPartyId: string,
    instrument: string,
    feeAmount: number
  ): Promise<boolean> {
    const commandId = `${batchId}-fee-${Date.now()}`;

    try {
      // Fetch factory (may be cached from batch execution, but safe to re-fetch)
      const factory = await this.registry.getTransferFactory();

      // Get sender's current holdings (refreshed after batch transfers)
      const holdingEvents = await this.ledger.getContractsByInterface(
        senderPartyId,
        DAML_IDS.tokenStandard.holding
      );

      const holdingCids = holdingEvents.map((h) => h.contractId);
      const holdingDisclosed = holdingEvents
        .filter((h) => h.createdEventBlob)
        .map((h) => ({
          templateId: DAML_IDS.tokenStandard.holding,
          contractId: h.contractId,
          createdEventBlob: h.createdEventBlob!,
        }));

      const now = new Date().toISOString();

      const choiceArgument = {
        expectedAdmin:
          config.canton.instrumentAdmin || this.operatorParty,
        transfer: {
          sender: senderPartyId,
          receiver: this.operatorParty,  // ← fee goes to Spraay operator
          amount: String(feeAmount),
          instrumentId: {
            admin: config.canton.instrumentAdmin || this.operatorParty,
            id: instrument,
          },
          lock: null,
          requestedAt: now,
          executeBefore: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          inputHoldingCids: holdingCids,
          meta: {
            values: {
              "splice.lfdecentralizedtrust.org/tx-kind": "transfer",
              "splice.lfdecentralizedtrust.org/sender": senderPartyId,
              "splice.lfdecentralizedtrust.org/reason":
                `Spraay protocol fee (${config.spraay.feeRate * 100}%) for batch ${batchId}`,
            },
          },
          context: factory.choiceContextData,
          extraArgs: {},
        },
      };

      const allDisclosed = [...factory.disclosedContracts, ...holdingDisclosed];

      await this.ledger.exerciseChoice(
        DAML_IDS.tokenStandard.transferFactory,
        factory.factoryId,
        "TransferFactory_Transfer",
        choiceArgument,
        [senderPartyId],
        commandId,
        allDisclosed
      );

      logger.info(
        `Protocol fee collected: ${feeAmount} ${instrument} → operator (${this.operatorParty.substring(0, 16)}...)`
      );
      return true;
    } catch (error: any) {
      logger.error(`Fee collection failed: ${error.message}`);
      return false;
    }
  }
}
