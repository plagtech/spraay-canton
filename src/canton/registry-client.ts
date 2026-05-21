// Spraay Canton — Token Standard Registry Client
//
// The Canton Token Standard requires fetching factory contracts and
// choice context from a Registry API before executing transfers.
// This registry is served by the Scan app at each validator.
//
// Key endpoints:
//   GET  /registry/transfer-instruction/v1/transfer-factory
//        → factoryId, disclosedContracts, choiceContextData
//
//   POST /registry/transfer-instruction/v1/{transferInstructionId}/choice-contexts/accept
//        → choiceContextData for accepting a TransferInstruction
//
// Reference: canton-network/splice/token-standard/cli/src/commands/transfer.ts

import { config, NETWORK_ENDPOINTS } from "../config";
import { DisclosedContract } from "./ledger-client";
import { logger } from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransferFactoryInfo {
  factoryId: string;
  disclosedContracts: DisclosedContract[];
  choiceContextData: Record<string, unknown>;
}

export interface ChoiceContextResponse {
  choiceContextData: Record<string, unknown>;
  disclosedContracts: DisclosedContract[];
}

// ---------------------------------------------------------------------------
// Registry Client
// ---------------------------------------------------------------------------

export class RegistryClient {
  private scanUrl: string;

  constructor(scanUrl?: string) {
    // Resolve Scan URL based on network environment
    if (scanUrl) {
      this.scanUrl = scanUrl;
    } else if (config.network === "localnet") {
      // LocalNet Scan app (cn-quickstart default)
      this.scanUrl =
        process.env.CANTON_SCAN_URL || "http://scan.localhost:4000";
    } else {
      const endpoints = NETWORK_ENDPOINTS[config.network];
      this.scanUrl =
        process.env.CANTON_SCAN_URL || endpoints?.scan || "";
    }

    logger.info(`Registry client initialized: ${this.scanUrl}`);
  }

  // -----------------------------------------------------------------------
  // TransferFactory
  // -----------------------------------------------------------------------

  /**
   * Fetch the TransferFactory contract info from the registry.
   *
   * This returns:
   *   - factoryId: the contract ID to exercise TransferFactory_Transfer on
   *   - disclosedContracts: must be attached to the command submission
   *   - choiceContextData: passed as `context` in the choice argument
   *
   * The registry serves this because the factory contract is owned by the
   * token administrator (not visible to the sender), so explicit disclosure
   * is needed.
   */
  async getTransferFactory(): Promise<TransferFactoryInfo> {
    const url = `${this.scanUrl}/registry/transfer-instruction/v1/transfer-factory`;
    logger.debug(`Fetching TransferFactory from ${url}`);

    const res = await fetch(url, {
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new RegistryError(
        `TransferFactory fetch failed (${res.status}): ${text}`
      );
    }

    const data = (await res.json()) as {
      factoryId: string;
      disclosedContracts?: any[];
      choiceContextData?: Record<string, unknown>;
    };

    return {
      factoryId: data.factoryId,
      disclosedContracts: (data.disclosedContracts || []).map(
        (dc: any) => ({
          templateId: dc.templateId,
          contractId: dc.contractId,
          createdEventBlob: dc.createdEventBlob,
        })
      ),
      choiceContextData: data.choiceContextData || {},
    };
  }

  // -----------------------------------------------------------------------
  // TransferInstruction choice contexts
  // -----------------------------------------------------------------------

  /**
   * Get choice context for accepting a TransferInstruction.
   */
  async getAcceptContext(
    transferInstructionId: string
  ): Promise<ChoiceContextResponse> {
    return this.getChoiceContext(transferInstructionId, "accept");
  }

  /**
   * Get choice context for rejecting a TransferInstruction.
   */
  async getRejectContext(
    transferInstructionId: string
  ): Promise<ChoiceContextResponse> {
    return this.getChoiceContext(transferInstructionId, "reject");
  }

  /**
   * Get choice context for withdrawing a TransferInstruction.
   */
  async getWithdrawContext(
    transferInstructionId: string
  ): Promise<ChoiceContextResponse> {
    return this.getChoiceContext(transferInstructionId, "withdraw");
  }

  private async getChoiceContext(
    transferInstructionId: string,
    action: "accept" | "reject" | "withdraw"
  ): Promise<ChoiceContextResponse> {
    const url = `${this.scanUrl}/registry/transfer-instruction/v1/${transferInstructionId}/choice-contexts/${action}`;
    logger.debug(`Fetching ${action} context from ${url}`);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new RegistryError(
        `Choice context ${action} failed (${res.status}): ${text}`
      );
    }

    const data = (await res.json()) as {
      choiceContextData?: Record<string, unknown>;
      disclosedContracts?: any[];
    };
    return {
      choiceContextData: data.choiceContextData || {},
      disclosedContracts: (data.disclosedContracts || []).map(
        (dc: any) => ({
          templateId: dc.templateId,
          contractId: dc.contractId,
          createdEventBlob: dc.createdEventBlob,
        })
      ),
    };
  }

  // -----------------------------------------------------------------------
  // Token metadata (optional — for instrument discovery)
  // -----------------------------------------------------------------------

  /**
   * Fetch token metadata from the registry.
   * Useful for discovering available instruments and their admins.
   */
  async getTokenMetadata(): Promise<Record<string, unknown>> {
    const url = `${this.scanUrl}/registry/metadata/v1/info`;
    const res = await fetch(url, { headers: this.authHeaders() });

    if (!res.ok) {
      throw new RegistryError(
        `Token metadata fetch failed (${res.status})`
      );
    }

    return (await res.json()) as Record<string, unknown>;
  }

  // -----------------------------------------------------------------------
  // Health check
  // -----------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.scanUrl}/api/scan/v1/readyz`, {
        headers: this.authHeaders(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Auth headers
  // -----------------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (config.canton.jwtToken) {
      headers["Authorization"] = `Bearer ${config.canton.jwtToken}`;
    }
    return headers;
  }
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}
