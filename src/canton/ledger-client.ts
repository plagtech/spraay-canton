// Spraay Canton — JSON Ledger API Client
//
// Wraps Canton's JSON Ledger API (OpenAPI at /docs/openapi) into a
// typed TypeScript client. Handles command submission, ACS queries,
// party management, and transaction streaming.
//
// Reference: https://docs.canton.network/appdev/modules/m4-json-api-tutorial

import { config } from "../config";
import { logger } from "../utils/logger";

// ---------------------------------------------------------------------------
// Types matching the Canton JSON Ledger API schemas
// ---------------------------------------------------------------------------

export interface CreateCommand {
  CreateCommand: {
    templateId: string;
    createArguments: Record<string, unknown>;
  };
}

export interface ExerciseCommand {
  ExerciseCommand: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: Record<string, unknown>;
  };
}

export type Command = CreateCommand | ExerciseCommand;

export interface SubmitRequest {
  commands: Command[];
  userId: string;
  commandId: string;
  actAs: string[];
  readAs: string[];
  disclosedContracts?: DisclosedContract[];
}

export interface DisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
}

export interface SubmitResponse {
  updateId: string;
  completionOffset: number;
}

export interface CreatedEvent {
  offset: number;
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
  createdEventBlob?: string;
  interfaceViews?: InterfaceView[];
}

export interface InterfaceView {
  interfaceId: string;
  viewValue: Record<string, unknown>;
}

export interface ActiveContractEntry {
  contractEntry: {
    JsActiveContract?: {
      createdEvent: CreatedEvent;
    };
  };
}

export interface PartyDetails {
  party: string;
  isLocal: boolean;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class CantonLedgerClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(baseUrl?: string, jwtToken?: string) {
    this.baseUrl = baseUrl || config.canton.ledgerApiUrl;
    this.headers = {
      "Content-Type": "application/json",
    };
    if (jwtToken || config.canton.jwtToken) {
      this.headers["Authorization"] = `Bearer ${jwtToken || config.canton.jwtToken}`;
    }
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/livez`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async getLedgerEnd(): Promise<number> {
    const res = await this.post("/v2/state/ledger-end", {});
    return res.offset;
  }

  // -------------------------------------------------------------------------
  // Party Management
  // -------------------------------------------------------------------------

  async allocateParty(hint: string): Promise<PartyDetails> {
    const res = await this.post("/v2/parties", {
      partyIdHint: hint,
      identityProviderId: "",
    });
    return res.partyDetails;
  }

  async listParties(): Promise<PartyDetails[]> {
    const res = await this.get("/v2/parties");
    return res.partyDetails || [];
  }

  // -------------------------------------------------------------------------
  // Command Submission
  // -------------------------------------------------------------------------

  /** Submit commands and wait for completion (synchronous) */
  async submitAndWait(request: SubmitRequest): Promise<SubmitResponse> {
    logger.debug(`Submitting command ${request.commandId} with ${request.commands.length} commands`);
    const res = await this.post("/v2/commands/submit-and-wait", request);
    logger.info(`Command ${request.commandId} committed at offset ${res.completionOffset}`);
    return res;
  }

  /** Submit commands fire-and-forget (async) */
  async submit(request: SubmitRequest): Promise<void> {
    await this.post("/v2/commands/submit", request);
  }

  // -------------------------------------------------------------------------
  // Active Contract Set (ACS) Queries
  // -------------------------------------------------------------------------

  /** Query active contracts by party and template */
  async getActiveContracts(
    party: string,
    templateId: string,
    offset?: number
  ): Promise<CreatedEvent[]> {
    const activeAt = offset ?? (await this.getLedgerEnd());

    const body = {
      activeAtOffset: activeAt,
      eventFormat: {
        filtersByParty: {
          [party]: {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: {
                    value: {
                      templateId,
                      includeCreatedEventBlob: true,
                    },
                  },
                },
              },
            ],
          },
        },
        verbose: false,
      },
    };

    const results: ActiveContractEntry[] = await this.post(
      "/v2/state/active-contracts",
      body
    );

    return results
      .map((r) => r.contractEntry?.JsActiveContract?.createdEvent)
      .filter((e): e is CreatedEvent => e !== undefined);
  }

  /** Query active contracts by party and Token Standard interface */
  async getContractsByInterface(
    party: string,
    interfaceId: string,
    offset?: number
  ): Promise<CreatedEvent[]> {
    const activeAt = offset ?? (await this.getLedgerEnd());

    const body = {
      activeAtOffset: activeAt,
      eventFormat: {
        filtersByParty: {
          [party]: {
            cumulative: [
              {
                identifierFilter: {
                  InterfaceFilter: {
                    value: {
                      interfaceId,
                      includeInterfaceView: true,
                      includeCreatedEventBlob: true,
                    },
                  },
                },
              },
            ],
          },
        },
        verbose: false,
      },
    };

    const results: ActiveContractEntry[] = await this.post(
      "/v2/state/active-contracts",
      body
    );

    return results
      .map((r) => r.contractEntry?.JsActiveContract?.createdEvent)
      .filter((e): e is CreatedEvent => e !== undefined);
  }

  // -------------------------------------------------------------------------
  // Convenience: Create a contract
  // -------------------------------------------------------------------------

  async createContract(
    templateId: string,
    args: Record<string, unknown>,
    actAs: string[],
    commandId: string
  ): Promise<SubmitResponse> {
    return this.submitAndWait({
      commands: [{ CreateCommand: { templateId, createArguments: args } }],
      userId: config.canton.userId,
      commandId,
      actAs,
      readAs: actAs,
    });
  }

  // -------------------------------------------------------------------------
  // Convenience: Exercise a choice
  // -------------------------------------------------------------------------

  async exerciseChoice(
    templateId: string,
    contractId: string,
    choice: string,
    args: Record<string, unknown>,
    actAs: string[],
    commandId: string,
    disclosedContracts?: DisclosedContract[]
  ): Promise<SubmitResponse> {
    return this.submitAndWait({
      commands: [
        {
          ExerciseCommand: {
            templateId,
            contractId,
            choice,
            choiceArgument: args,
          },
        },
      ],
      userId: config.canton.userId,
      commandId,
      actAs,
      readAs: actAs,
      disclosedContracts,
    });
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  private async post(path: string, body: unknown): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error(`Ledger API error ${res.status} on ${path}: ${errText}`);
      throw new LedgerApiError(res.status, path, errText);
    }

    return res.json();
  }

  private async get(path: string): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, { headers: this.headers });

    if (!res.ok) {
      const errText = await res.text();
      throw new LedgerApiError(res.status, path, errText);
    }

    return res.json();
  }
}

export class LedgerApiError extends Error {
  constructor(
    public status: number,
    public path: string,
    public detail: string
  ) {
    super(`Ledger API ${status} on ${path}: ${detail}`);
    this.name = "LedgerApiError";
  }
}
