# 💧 Spraay Canton

**Batch payment infrastructure for Canton Network** — UTXO-optimized batch transfers, MCP tooling for AI agents, and Canton Coin reward integration.

Spraay Canton brings [Spraay Protocol](https://gateway.spraay.app)'s multi-chain batch payment orchestration to [Canton Network](https://canton.network), the privacy-enabled blockchain for regulated assets.

## What It Does

Canton uses a UTXO model for token holdings (CIP-0056 Token Standard). Spraay Canton provides:

- **Batch transfers** — Send to N recipients in an optimized sequence of `TransferFactory_Transfer` commands
- **UTXO management** — Small-first selection strategy, dust consolidation, and merge delegation
- **MCP tools** — 5 tools for AI agent frameworks (LangChain, AutoGPT, CrewAI) to execute batch payments
- **CC rewards** — Automatic `FeaturedAppActivityMarker` creation for Canton Coin minting rewards
- **REST API** — Express server compatible with the Spraay gateway pattern

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  AI Agents / Clients                  │
│          (MCP tools  |  REST API  |  Gateway)         │
└──────────────┬────────────────────┬──────────────────┘
               │                    │
       ┌───────▼───────┐    ┌──────▼──────┐
       │  MCP Server   │    │  Express API │
       │  (5 tools)    │    │  /api/v1/*   │
       └───────┬───────┘    └──────┬──────┘
               │                    │
         ┌─────▼────────────────────▼─────┐
         │      Batch Orchestrator         │
         │  • UTXO selection (small-first) │
         │  • Transfer construction        │
         │  • Activity marker creation     │
         └─────────────┬──────────────────┘
                       │
              ┌────────▼────────┐
              │  Canton Ledger  │
              │   Client        │
              │  (JSON API)     │
              └────────┬────────┘
                       │ HTTP/JSON
              ┌────────▼────────┐
              │  Canton Node    │
              │  (Participant)  │
              │  port 7575      │
              └─────────────────┘
```

## Daml Model

The `daml/Spraay/BatchPayment.daml` module defines:

| Contract | Purpose |
|---|---|
| `SpraayServiceConfig` | Operator settings (fee rate, max batch size) |
| `BatchPaymentRequest` | Submitted by sender, accepted by operator |
| `BatchPaymentExecution` | Active during batch processing |
| `BatchPaymentReceipt` | Immutable completion record (queryable via PQS) |
| `SpraayActivityMarker` | Drives Canton Coin reward minting |

## Quick Start

### Prerequisites

- Node.js 18.20+
- [DPM](https://docs.canton.network) (`curl -sSL https://get.digitalasset.com/install/install.sh | sh -s`)
- Canton sandbox (included with DPM)

### Setup

```bash
# Clone
git clone https://github.com/plagtech/spraay-canton.git
cd spraay-canton

# Install
npm install

# Build Daml model
dpm build

# Copy env
cp env.example .env

# Start Canton sandbox (background)
npm run sandbox &

# Generate TypeScript types from OpenAPI
npm run generate:api

# Start Spraay Canton
npm run dev
```

### First Batch Payment

```bash
# 1. Allocate test parties
curl -X POST http://localhost:3100/api/v1/parties \
  -H "Content-Type: application/json" \
  -d '{"hint": "Alice"}'
# → {"party": "Alice::1220abc...", "isLocal": true}

curl -X POST http://localhost:3100/api/v1/parties \
  -H "Content-Type: application/json" \
  -d '{"hint": "Bob"}'

curl -X POST http://localhost:3100/api/v1/parties \
  -H "Content-Type: application/json" \
  -d '{"hint": "Carol"}'

# 2. Submit batch payment
curl -X POST http://localhost:3100/api/v1/batch \
  -H "Content-Type: application/json" \
  -d '{
    "senderPartyId": "Alice::1220abc...",
    "recipients": [
      {"partyId": "Bob::1220def...", "amount": 10.0, "memo": "Payment 1"},
      {"partyId": "Carol::1220ghi...", "amount": 5.0, "memo": "Payment 2"}
    ],
    "instrument": "CantonCoin"
  }'

# 3. Check holdings
curl http://localhost:3100/api/v1/holdings/Alice::1220abc...
```

## MCP Integration

### Smithery

```json
{
  "name": "spraay-canton",
  "version": "0.1.0",
  "tools": [
    "canton_batch_payment",
    "canton_query_holdings",
    "canton_batch_status",
    "canton_allocate_party",
    "canton_health"
  ]
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "spraay-canton": {
      "command": "npx",
      "args": ["ts-node", "src/mcp/server.ts"],
      "env": {
        "CANTON_LEDGER_API_URL": "http://localhost:7575",
        "SPRAAY_OPERATOR_PARTY_ID": "your-operator-party-id"
      }
    }
  }
}
```

## Canton Network Integration

### Token Standard (CIP-0056)

Spraay Canton interacts with Canton's Token Standard interfaces:

- **Holding** (`splice-api-token-holding-v1`) — UTXO queries and balance checks
- **TransferFactory** (`splice-api-token-transfer-instruction-v1`) — Transfer execution
- **TransferInstruction** — Transfer acceptance and tracking

### App Rewards

When deployed as a **featured app** on Canton Network, each successful batch generates a `FeaturedAppActivityMarker` that SV automation converts into `AppRewardCoupon` contracts for Canton Coin minting.

Self-featuring is available on DevNet for testing the reward flow.

### Deployment Progression

1. **LocalNet** — `dpm sandbox` for development
2. **DevNet** — Self-featured, test reward flow
3. **TestNet** — GSF approval required
4. **MainNet** — Production deployment

## Project Structure

```
spraay-canton/
├── daml/
│   └── Spraay/
│       └── BatchPayment.daml      # On-ledger contracts
├── src/
│   ├── api/
│   │   └── server.ts              # Express REST API
│   ├── batch/
│   │   ├── orchestrator.ts        # Batch execution engine
│   │   └── utxo-selection.ts      # UTXO selection strategy
│   ├── canton/
│   │   └── ledger-client.ts       # JSON Ledger API client
│   ├── mcp/
│   │   └── server.ts              # MCP tool server
│   ├── utils/
│   │   └── logger.ts
│   ├── config.ts                  # Environment configuration
│   └── index.ts                   # Main entry point
├── daml.yaml                      # Daml project config
├── package.json
├── tsconfig.json
└── env.example
```

## Links

- [Spraay Gateway](https://gateway.spraay.app) — Main x402 gateway
- [Canton Docs](https://docs.canton.network) — Canton Network documentation
- [CIP-0056](https://github.com/global-synchronizer-foundation/cips/blob/main/cip-0056/cip-0056.md) — Token Standard
- [Canton Dev Fund](https://github.com/canton-foundation/canton-dev-fund) — Grant proposals

## License

0BSD — same as the Canton Quickstart.
