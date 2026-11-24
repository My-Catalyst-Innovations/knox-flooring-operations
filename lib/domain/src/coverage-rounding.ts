import { coverageMicros } from "./bill-receipt-coverage";

/** Only the server may assemble this from retained bill, price and receipt sources.
 * The pure verifier proves arithmetic; it cannot establish source authenticity. */
export type CoverageRoundingEvidence = {
  version: 1;
  buyQuantity: string;
  buyUnitCost: string;
  approvedBuyUnitCost: string;
  stockUnitsPerBuyUnit: string;
  approvedStockUnitsPerBuyUnit: string;
  printedLineAmountCents: string;
  stockQuantity: string;
  receiptStockUnitCost: string;
  billedStockUnitCost: string;
};
const cents = (value: bigint) => (value + 5_000_000_000n) / 10_000_000_000n;
export function verifyCoverageRoundingEvidence(
  evidence: unknown,
  receiptUnitCost: string,
  billedUnitCost: string,
  billStockQuantity: string,
): evidence is CoverageRoundingEvidence {
  try {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
      return false;
    const e = evidence as CoverageRoundingEvidence;
    if (
      e.version !== 1 ||
      typeof e.printedLineAmountCents !== "string" ||
      !/^(0|[1-9]\d{0,15})$/.test(e.printedLineAmountCents)
    )
      return false;
    const qty = coverageMicros(e.buyQuantity),
      buy = coverageMicros(e.buyUnitCost),
      factor = coverageMicros(e.stockUnitsPerBuyUnit);
    const stock = coverageMicros(e.stockQuantity),
      received = coverageMicros(receiptUnitCost),
      billed = coverageMicros(billedUnitCost);
    if (
      qty <= 0n ||
      factor <= 1_000_000n ||
      stock <= 0n ||
      buy !== coverageMicros(e.approvedBuyUnitCost) ||
      factor !== coverageMicros(e.approvedStockUnitsPerBuyUnit)
    )
      return false;
    if (
      stock !== coverageMicros(billStockQuantity) ||
      received !== coverageMicros(e.receiptStockUnitCost) ||
      billed !== coverageMicros(e.billedStockUnitCost)
    )
      return false;
    if (
      qty * factor !== stock * 1_000_000n ||
      billed !== (buy * 2_000_000n + factor) / (2n * factor)
    )
      return false;
    const difference = billed - received;
    if (difference === 0n || difference < -1n || difference > 1n) return false;
    const printed = BigInt(e.printedLineAmountCents);
    return (
      cents(qty * buy) === printed &&
      cents(stock * billed) === printed &&
      cents(stock * received) === printed
    );
  } catch {
    return false;
  }
}

/** Round one exact twelve-place extension for display; no ledger amount changes. */
export function coverageDisplayCents(value: bigint): string {
  const negative = value < 0n;
  const amount = cents(negative ? -value : value);
  return `${negative && amount !== 0n ? "-" : ""}${amount}`;
}
