// Spraay Canton — UTXO Selection Engine
//
// Canton uses a UTXO model for token holdings. Each active Holding
// contract is a UTXO. The Token Standard docs recommend:
//   - Keep UTXOs per user below ~10 on average
//   - Prefer selection of small-amount Holding UTXOs first
//   - Max 100 input contracts per single transfer
//
// This module implements the UTXO selection strategy for batch payments.

import { CreatedEvent } from "../canton/ledger-client";
import { logger } from "../utils/logger";

export interface HoldingUtxo {
  contractId: string;
  amount: number;
  owner: string;
  instrument: string;
  createdEventBlob?: string;
  templateId: string;
}

export interface UtxoSelection {
  selected: HoldingUtxo[];
  totalSelected: number;
  change: number; // amount to return as change UTXO
  sufficient: boolean;
}

/**
 * Parse Holding interface views from Canton ACS query results
 * into a typed UTXO list.
 */
export function parseHoldings(events: CreatedEvent[]): HoldingUtxo[] {
  return events
    .map((event) => {
      // The Holding interface view contains: owner, amount, instrument, lock
      const view = event.interfaceViews?.find((v) =>
        v.interfaceId.includes("HoldingV1:Holding")
      )?.viewValue;

      if (!view) {
        // Fallback: try createArgument directly
        const args = event.createArgument;
        return {
          contractId: event.contractId,
          amount: parseFloat(String(args.amount || "0")),
          owner: String(args.owner || ""),
          instrument: String(args.instrument || "unknown"),
          createdEventBlob: event.createdEventBlob,
          templateId: event.templateId,
        };
      }

      return {
        contractId: event.contractId,
        amount: parseFloat(String(view.amount || "0")),
        owner: String(view.owner || ""),
        instrument: String(view.instrument || "unknown"),
        createdEventBlob: event.createdEventBlob,
        templateId: event.templateId,
      };
    })
    .filter((h) => h.amount > 0);
}

/**
 * Select optimal UTXOs for a given target amount.
 *
 * Strategy (per Canton docs recommendations):
 *   1. Sort by amount ascending (prefer small UTXOs first — reduces dust)
 *   2. Accumulate until target is met
 *   3. If exact match, great — no change UTXO needed
 *   4. Cap at 100 inputs (Canton Token Standard limit)
 */
export function selectUtxos(
  holdings: HoldingUtxo[],
  targetAmount: number,
  maxInputs: number = 100
): UtxoSelection {
  // Sort ascending — small UTXOs first (Canton recommendation)
  const sorted = [...holdings].sort((a, b) => a.amount - b.amount);

  const selected: HoldingUtxo[] = [];
  let accumulated = 0;

  for (const utxo of sorted) {
    if (accumulated >= targetAmount) break;
    if (selected.length >= maxInputs) break;

    selected.push(utxo);
    accumulated += utxo.amount;
  }

  const sufficient = accumulated >= targetAmount;
  const change = sufficient ? accumulated - targetAmount : 0;

  if (!sufficient) {
    logger.warn(
      `Insufficient holdings: need ${targetAmount}, have ${accumulated} across ${holdings.length} UTXOs`
    );
  }

  return { selected, totalSelected: accumulated, change, sufficient };
}

/**
 * Check if a user's UTXO count exceeds the recommended threshold
 * and needs merging.
 */
export function needsMerging(holdings: HoldingUtxo[], threshold: number = 10): boolean {
  return holdings.length > threshold;
}

/**
 * Identify dust UTXOs that are candidates for merging.
 * Returns the smallest UTXOs that together don't exceed the merge batch limit.
 */
export function identifyMergeCandidates(
  holdings: HoldingUtxo[],
  targetUtxoCount: number = 5,
  maxMergeInputs: number = 100
): HoldingUtxo[] {
  if (holdings.length <= targetUtxoCount) return [];

  const sorted = [...holdings].sort((a, b) => a.amount - b.amount);
  const mergeCount = Math.min(
    holdings.length - targetUtxoCount,
    maxMergeInputs
  );

  return sorted.slice(0, mergeCount);
}
