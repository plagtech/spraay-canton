// Spraay Canton — MCP Server
//
// Exposes batch payment capabilities as MCP tools for AI agent
// frameworks (LangChain, AutoGPT, CrewAI, etc.) to discover and use.
//
// Tools:
//   - canton_batch_payment:    Execute a batch of token transfers
//   - canton_query_holdings:   Check a party's token balance and UTXOs
//   - canton_batch_status:     Look up a batch payment receipt
//   - canton_allocate_party:   Create a new party (dev/sandbox)
//   - canton_health:           Check service and Canton node health

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CantonLedgerClient } from "../canton/ledger-client";
import { BatchOrchestrator } from "../batch/orchestrator";
import { config } from "../config";
import { logger } from "../utils/logger";

export async function startMcpServer(): Promise<void> {
  const ledger = new CantonLedgerClient();
  const orchestrator = new BatchOrchestrator(ledger);

  const server = new Server(
    {
      name: "spraay-canton",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // -----------------------------------------------------------------------
  // Tool Definitions
  // -----------------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "canton_batch_payment",
        description:
          "Execute a batch of token transfers on Canton Network. Supports CantonCoin and USDCx. " +
          "Automatically selects optimal UTXOs, constructs TransferFactory commands, and creates " +
          "activity markers for CC rewards. Max 100 recipients per batch.",
        inputSchema: {
          type: "object" as const,
          properties: {
            senderPartyId: {
              type: "string",
              description: "Canton party ID of the sender (e.g. 'Alice::1220abc...')",
            },
            recipients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  partyId: { type: "string", description: "Recipient's Canton party ID" },
                  amount: { type: "number", description: "Amount to transfer" },
                  memo: { type: "string", description: "Optional payment memo" },
                },
                required: ["partyId", "amount"],
              },
              description: "List of recipients with amounts",
            },
            instrument: {
              type: "string",
              description: "Token instrument: 'CantonCoin' or 'USDCx'",
              enum: ["CantonCoin", "USDCx"],
            },
          },
          required: ["senderPartyId", "recipients", "instrument"],
        },
      },
      {
        name: "canton_query_holdings",
        description:
          "Query a Canton party's token holdings. Returns UTXO count, total balance, " +
          "and whether the account needs UTXO merging (Canton recommends <10 UTXOs per user).",
        inputSchema: {
          type: "object" as const,
          properties: {
            partyId: {
              type: "string",
              description: "Canton party ID to query",
            },
            instrument: {
              type: "string",
              description: "Optional: filter by instrument ('CantonCoin', 'USDCx')",
            },
          },
          required: ["partyId"],
        },
      },
      {
        name: "canton_batch_status",
        description:
          "Look up the status and receipt of a previously submitted batch payment.",
        inputSchema: {
          type: "object" as const,
          properties: {
            batchId: {
              type: "string",
              description: "The batch ID returned from canton_batch_payment",
            },
          },
          required: ["batchId"],
        },
      },
      {
        name: "canton_allocate_party",
        description:
          "Allocate a new party on the Canton sandbox/DevNet. Returns the full party ID. " +
          "For development and testing only.",
        inputSchema: {
          type: "object" as const,
          properties: {
            hint: {
              type: "string",
              description: "Human-readable party name hint (e.g. 'Alice', 'TreasuryBot')",
            },
          },
          required: ["hint"],
        },
      },
      {
        name: "canton_health",
        description:
          "Check Spraay Canton service health and connectivity to the Canton participant node.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
    ],
  }));

  // -----------------------------------------------------------------------
  // Tool Execution
  // -----------------------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "canton_batch_payment": {
          const result = await orchestrator.executeBatch({
            senderPartyId: args!.senderPartyId as string,
            recipients: args!.recipients as any[],
            instrument: args!.instrument as string,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "canton_query_holdings": {
          const partyId = args!.partyId as string;
          const events = await ledger.getContractsByInterface(
            partyId,
            "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding"
          );
          const holdings = events.map((e) => ({
            contractId: e.contractId,
            amount: e.createArgument?.amount,
            instrument: e.createArgument?.instrument,
          }));
          const total = holdings.reduce(
            (s, h) => s + parseFloat(String(h.amount || 0)),
            0
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    partyId,
                    utxoCount: holdings.length,
                    totalBalance: total,
                    needsMerging: holdings.length > config.spraay.maxUtxoTarget,
                    holdings,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "canton_batch_status": {
          const batchId = args!.batchId as string;
          const receipts = await ledger.getActiveContracts(
            config.canton.operatorPartyId,
            "#spraay-canton:Spraay.BatchPayment:BatchPaymentReceipt"
          );
          const receipt = receipts.find(
            (r) => (r.createArgument as any).batchId === batchId
          );
          if (!receipt) {
            return { content: [{ type: "text", text: `Batch ${batchId} not found` }] };
          }
          return {
            content: [{ type: "text", text: JSON.stringify(receipt.createArgument, null, 2) }],
          };
        }

        case "canton_allocate_party": {
          const party = await ledger.allocateParty(args!.hint as string);
          return { content: [{ type: "text", text: JSON.stringify(party, null, 2) }] };
        }

        case "canton_health": {
          const healthy = await ledger.isHealthy();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    service: "spraay-canton",
                    version: "0.1.0",
                    canton: healthy ? "connected" : "unreachable",
                    network: config.network,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
      }
    } catch (error: any) {
      logger.error(`MCP tool ${name} error:`, error);
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Spraay Canton MCP server started on stdio");
}

// Direct execution
if (require.main === module) {
  startMcpServer().catch(console.error);
}
