import {
  coverageDisplayCents,
  verifyCoverageRoundingEvidence,
  type CoverageRoundingEvidence,
} from "./coverage-rounding";
export type CoverageMode = "local_review" | "quickbooks_verified";
export type CoverageCompany = {
  connectionId: string;
  realmId: string;
  environment: "sandbox" | "production";
  companyName: string;
};
export interface CoverageReceipt {
  id: string;
  receiptId: string;
  orderId: string;
  orderNumber: string;
  reference: string;
  supplier: string;
  productId: string;
  sku: string;
  productName: string;
  warehouseId: string;
  warehouseName: string;
  stockUnit: string;
  quantity: string;
  unitCost: string;
  allocatedQuantity: string;
  remainingQuantity: string;
  sourceFingerprint: string;
}
export interface CoverageBillLine {
  key: string;
  billId: string;
  billLineIndex: number;
  billNumber: string;
  supplier: string;
  productId: string;
  sku: string;
  productName: string;
  stockUnit: string;
  quantity: string;
  unitCost: string;
  allocatedQuantity: string;
  remainingQuantity: string;
  sourceFingerprint: string;
  vendorId: string | null;
  itemId: string | null;
  postedBillId: string | null;
  verification: "local_only" | "verified";
  eligible: boolean;
  blockedReason: string | null;
  /** Server-assembled source proof; never accepted in a request body. */
  roundingSource?: Omit<CoverageRoundingEvidence, "receiptStockUnitCost">;
}
export type CoverageChoice = {
  billIds: string[];
  allocations: Array<{
    receiptLineId: string;
    billId: string;
    billLineIndex: number;
    quantity: string;
    varianceNote: string;
    existingAllocationId?: string;
    reconciliationNote?: string;
  }>;
  note: string;
};
export type CoveragePreviewLine = CoverageChoice["allocations"][number] & {
  receipt: CoverageReceipt;
  bill: CoverageBillLine;
  receiptExtendedCost: string;
  billedExtendedCost: string;
  variance: string;
  varianceClassification:
    | "none"
    | "unit_conversion_rounding"
    | "price_variance";
  displayVarianceCents: string;
  roundingEvidence?: CoverageRoundingEvidence;
};
export interface CoverageAllocation {
  id: string;
  approvalId: string;
  receiptLineId: string;
  billId: string;
  billLineIndex: number;
  productId: string;
  quantity: string;
  stockUnit: string;
  receiptUnitCost: string;
  billedUnitCost: string;
  varianceNote: string;
  createdAt: string;
  mode: CoverageMode;
  sourceBillNumber: string;
  providerBoundQuantity: string;
  unboundQuantity: string;
}
export type BillDocument = {
  id: string;
  billId: string;
  fileName: string;
  size: number;
  sha256: string;
  downloadUrl: string;
  createdAt: string;
};
export type CoveragePreview = {
  fingerprint: string;
  mode: CoverageMode;
  company: CoverageCompany | null;
  lines: CoveragePreviewLine[];
  warnings: string[];
  receiptResiduals: Array<{ id: string; remainingQuantity: string }>;
  billResiduals: Array<{ key: string; remainingQuantity: string }>;
  observedAt: string;
  identityWarnings: string[];
  hasHistoricalIdentities: boolean;
};
export type CoverageOptions = {
  mode: CoverageMode;
  company: CoverageCompany | null;
  bills: CoverageBillLine[];
  receipts: CoverageReceipt[];
  allocations: CoverageAllocation[];
  documents: BillDocument[];
  manualCases: unknown[];
  observedAt: string;
  hasMore: boolean;
};
export type CoverageBillStatus = {
  billId: string;
  mode: CoverageMode;
  coverageAvailable: boolean;
  blockedReason: string | null;
  allocations: CoverageAllocation[];
  documents: BillDocument[];
  manualCases: unknown[];
};
export type CoverageApproval = {
  id: string;
  requestKey: string;
  fingerprint: string;
  allocations: CoverageAllocation[];
  createdAt: string;
  replayed: boolean;
};

const six = 1_000_000n;
const max = 999_999_999_999_999_999n; // numeric(18,6), never a binary float.
export function coverageMicros(value: string): bigint {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value)
  )
    throw new Error(
      "Use an exact nonnegative decimal with at most six places.",
    );
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole) * six + BigInt(fraction.padEnd(6, "0"));
  if (units > max)
    throw new Error(
      "The quantity or cost exceeds the supported decimal range.",
    );
  return units;
}
export function coverageDecimal(units: bigint, places = 6): string {
  const sign = units < 0n ? "-" : "",
    positive = units < 0n ? -units : units,
    scale = 10n ** BigInt(places);
  return `${sign}${positive / scale}.${String(positive % scale).padStart(places, "0")}`;
}
const key = (billId: string, index: number) => `${billId}:${index}`;
const normalized = (value: string) => value.trim().toLowerCase();
export function previewReceiptBillCoverage(
  choice: CoverageChoice,
  receipts: CoverageReceipt[],
  bills: CoverageBillLine[],
  existingAllocations: CoverageAllocation[] = [],
) {
  if (
    choice.note.trim().length < 10 ||
    choice.note.trim().length > 1000 ||
    choice.allocations.length < 1 ||
    choice.allocations.length > 100 ||
    choice.billIds.length < 1 ||
    choice.billIds.length > 20 ||
    new Set(choice.billIds).size !== choice.billIds.length
  )
    throw new Error(
      "Choose up to twenty bills, one to one hundred allocations and a meaningful review note.",
    );
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt])),
    billByKey = new Map(bills.map((bill) => [bill.key, bill]));
  const usedReceipts = new Map<string, bigint>(),
    usedBills = new Map<string, bigint>(),
    usedExisting = new Map<string, bigint>(),
    tuples = new Set<string>();
  const lines: CoveragePreviewLine[] = [],
    warnings = new Set<string>();
  for (const input of choice.allocations) {
    const receipt = receiptById.get(input.receiptLineId),
      billKey = key(input.billId, input.billLineIndex),
      bill = billByKey.get(billKey);
    const tuple = JSON.stringify([
      input.receiptLineId,
      input.billId,
      input.billLineIndex,
      input.existingAllocationId ?? null,
    ]);
    if (tuples.has(tuple))
      throw new Error(
        "Each receipt and bill-line pair needs one explicit allocation; duplicate rows are not merged.",
      );
    tuples.add(tuple);
    if (
      !receipt ||
      !bill ||
      !choice.billIds.includes(bill.billId) ||
      !bill.eligible
    )
      throw new Error(
        "Choose current eligible receipt and merchandise bill lines from this review.",
      );
    if (
      receipt.productId !== bill.productId ||
      receipt.stockUnit !== bill.stockUnit ||
      normalized(receipt.supplier) !== normalized(bill.supplier)
    )
      throw new Error(
        "The supplier, actual product and exact stock unit must match on both sides.",
      );
    const quantity = coverageMicros(input.quantity),
      receiptCost = coverageMicros(receipt.unitCost),
      billCost = coverageMicros(bill.unitCost);
    if (quantity <= 0n)
      throw new Error("Allocate a positive received stock quantity.");
    const note = input.varianceNote.trim();
    const roundingEvidence = bill.roundingSource
      ? { ...bill.roundingSource, receiptStockUnitCost: receipt.unitCost }
      : undefined;
    const rounding = verifyCoverageRoundingEvidence(
      roundingEvidence,
      receipt.unitCost,
      bill.unitCost,
      bill.quantity,
    );
    const varianceClassification =
      receiptCost === billCost
        ? "none"
        : rounding
          ? "unit_conversion_rounding"
          : "price_variance";
    if (
      note.length > 500 ||
      (varianceClassification === "price_variance" && note.length < 10)
    )
      throw new Error(
        "Record a meaningful, explicit receipt-cost versus billed-cost variance note; matching quantities never revalue a receipt.",
      );
    const existing = input.existingAllocationId
      ? existingAllocations.find((row) => row.id === input.existingAllocationId)
      : undefined;
    if (
      input.existingAllocationId &&
      (!existing ||
        existing.mode !== "local_review" ||
        bill.verification !== "verified" ||
        existing.receiptLineId !== receipt.id ||
        existing.productId !== receipt.productId ||
        existing.stockUnit !== receipt.stockUnit ||
        normalized(existing.sourceBillNumber) !== normalized(bill.billNumber))
    )
      throw new Error(
        "Choose explicit prior local coverage for this same received product and source bill number; provider evidence cannot silently replace its history.",
      );
    if (existing) {
      const bound = (usedExisting.get(existing.id) ?? 0n) + quantity;
      if (
        coverageMicros(existing.providerBoundQuantity) + bound >
        coverageMicros(existing.quantity)
      )
        throw new Error(
          "Provider endorsements exceed the remaining original local coverage across companies.",
        );
      const reconciliationNote = input.reconciliationNote?.trim() ?? "";
      if (
        reconciliationNote.length > 500 ||
        (coverageMicros(existing.billedUnitCost) !== billCost &&
          reconciliationNote.length < 10)
      )
        throw new Error(
          "Separately review the provider bill price versus the original local bill price; neither original cost is overwritten.",
        );
      usedExisting.set(existing.id, bound);
      warnings.add(
        "This explicitly appends provider evidence to existing local coverage. It does not receive or allocate the same physical stock again.",
      );
    }
    const receiptUsed =
        (usedReceipts.get(receipt.id) ?? 0n) + (existing ? 0n : quantity),
      billUsed = (usedBills.get(bill.key) ?? 0n) + quantity;
    if (
      coverageMicros(receipt.allocatedQuantity) + receiptUsed >
      coverageMicros(receipt.quantity)
    )
      throw new Error(
        "This allocation exceeds the remaining accepted receipt quantity; damaged or returned quantities do not create extra coverage.",
      );
    if (
      coverageMicros(bill.allocatedQuantity) + billUsed >
      coverageMicros(bill.quantity)
    )
      throw new Error(
        "This allocation exceeds the remaining bill merchandise-line quantity.",
      );
    usedReceipts.set(receipt.id, receiptUsed);
    usedBills.set(bill.key, billUsed);
    if (varianceClassification === "price_variance")
      warnings.add(
        "Received acquisition cost differs from billed cost. Both original costs are retained; this review does not revalue inventory or post a financial adjustment.",
      );
    if (rounding)
      warnings.add(
        "Documented purchase-unit conversion rounding preserves the full printed line cents. Exact original costs and twelve-place residuals are retained; no receipt is revalued.",
      );
    if (bill.verification === "local_only")
      warnings.add(
        "Local bill review only. This is not posted or provider-verified QuickBooks evidence, and connecting a company later does not upgrade it.",
      );
    lines.push({
      ...input,
      quantity: coverageDecimal(quantity),
      varianceNote: note,
      receipt,
      bill,
      receiptExtendedCost: coverageDecimal(quantity * receiptCost, 12),
      billedExtendedCost: coverageDecimal(quantity * billCost, 12),
      variance: coverageDecimal(quantity * (billCost - receiptCost), 12),
      varianceClassification,
      displayVarianceCents: coverageDisplayCents(
        quantity * (billCost - receiptCost),
      ),
      ...(rounding ? { roundingEvidence } : {}),
    });
  }
  const receiptResiduals = [...usedReceipts].map(([id, quantity]) => ({
    id,
    remainingQuantity: coverageDecimal(
      coverageMicros(receiptById.get(id)!.quantity) -
        coverageMicros(receiptById.get(id)!.allocatedQuantity) -
        quantity,
    ),
  }));
  const billResiduals = [...usedBills].map(([id, quantity]) => ({
    key: id,
    remainingQuantity: coverageDecimal(
      coverageMicros(billByKey.get(id)!.quantity) -
        coverageMicros(billByKey.get(id)!.allocatedQuantity) -
        quantity,
    ),
  }));
  return { lines, warnings: [...warnings], receiptResiduals, billResiduals };
}
