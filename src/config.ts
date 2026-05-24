// Spraay Canton — Environment Configuration
// All Canton-specific and Spraay-specific settings

import dotenv from "dotenv";
dotenv.config();

export const config = {
  // Canton JSON Ledger API
  canton: {
    ledgerApiUrl: process.env.CANTON_LEDGER_API_URL || "http://localhost:7575",
    adminApiUrl: process.env.CANTON_ADMIN_API_URL || "http://localhost:5012",
    scanUrl: process.env.CANTON_SCAN_URL || "http://scan.localhost:4000",
    jwtToken: process.env.CANTON_JWT_TOKEN || "",
    operatorPartyId: process.env.SPRAAY_OPERATOR_PARTY_ID || "",
    instrumentAdmin: process.env.CANTON_INSTRUMENT_ADMIN || "",
    userId: process.env.CANTON_USER_ID || "spraay-operator",
    synchronizerId: process.env.CANTON_SYNCHRONIZER_ID || "",
  },

  // Spraay Protocol settings
  spraay: {
    feeRate: parseFloat(process.env.SPRAAY_FEE_RATE || "0.003"), // 0.3%
    maxBatchSize: parseInt(process.env.SPRAAY_MAX_BATCH_SIZE || "100"),
    maxUtxoTarget: parseInt(process.env.SPRAAY_MAX_UTXO_TARGET || "10"),
    gatewayUrl: process.env.SPRAAY_GATEWAY_URL || "https://gateway.spraay.app",
  },

  // Server
  server: {
    port: parseInt(process.env.PORT || "3100"),
    host: process.env.HOST || "0.0.0.0",
  },

  // Network environment
  network: (process.env.CANTON_NETWORK || "localnet") as
    | "localnet"
    | "devnet"
    | "testnet"
    | "mainnet",
} as const;

// Canton Network scan endpoints for each environment
export const NETWORK_ENDPOINTS: Record<string, { scan: string; sequencer: string }> = {
  devnet: {
    scan: "https://scan.sv-1.dev.global.canton.network.sync.global",
    sequencer: "https://sequencer-1.sv-1.dev.global.canton.network.sync.global",
  },
  testnet: {
    scan: "https://scan.sv-1.test.global.canton.network.sync.global",
    sequencer: "https://sequencer-1.sv-1.test.global.canton.network.sync.global",
  },
  mainnet: {
    scan: "https://scan.sv-1.global.canton.network.sync.global",
    sequencer: "https://sequencer-1.sv-1.global.canton.network.sync.global",
  },
};

// Daml package and template IDs
// These are populated after `dpm build` compiles the Daml model
export const DAML_IDS = {
  packagePrefix: "#spraay-canton",
  templates: {
    serviceConfig: `${pkg()}:Spraay.BatchPayment:SpraayServiceConfig`,
    batchRequest: `${pkg()}:Spraay.BatchPayment:BatchPaymentRequest`,
    batchExecution: `${pkg()}:Spraay.BatchPayment:BatchPaymentExecution`,
    batchReceipt: `${pkg()}:Spraay.BatchPayment:BatchPaymentReceipt`,
    activityMarker: `${pkg()}:Spraay.BatchPayment:SpraayActivityMarker`,
  },
  // Canton Token Standard interfaces
  tokenStandard: {
    holding: "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
    transferFactory:
      "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
    transferInstruction:
      "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
  },
} as const;

function pkg(): string {
  // After first build, replace with actual package hash from .daml/dist/
  return process.env.SPRAAY_DAML_PACKAGE_ID || "#spraay-canton";
}
