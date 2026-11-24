import { customFetch } from "@workspace/api-client-react";
import {
  verifyCoverageRoundingEvidence,
  type CoverageRoundingEvidence,
} from "@workspace/domain";

export const receiptCoveragePath = "/quickbooks/receipt-coverage";
export type CoverageMode = "local_review" | "quickbooks_verified";
export type CoverageCompany = {
  connectionId: string;
  realmId: string;
  environment: string;
  companyName: string;
};
export type CoverageBillLine = {
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
  roundingSource?: Omit<CoverageRoundingEvidence, "receiptStockUnitCost">;
};
export type CoverageReceipt = {
  id: string;
  receiptId: string;
  orderId: string;
  orderNumber: string;
  reference: string | null;
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
};
export type CoverageAllocation = {
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
};
export type BillDocument = {
  id: string;
  billId: string;
  fileName: string;
  size: number;
  sha256: string;
  downloadUrl: string;
  createdAt: string;
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
export type CoverageChoice = {
  billIds: string[];
  allocations: {
    receiptLineId: string;
    billId: string;
    billLineIndex: number;
    quantity: string;
    varianceNote: string;
    existingAllocationId?: string;
    reconciliationNote?: string;
  }[];
  note: string;
};
export type CoveragePreview = {
  fingerprint: string;
  mode: CoverageMode;
  company: CoverageCompany | null;
  lines: (CoverageChoice["allocations"][number] & {
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
  })[];
  warnings: string[];
  receiptResiduals: { id: string; remainingQuantity: string }[];
  billResiduals: { key: string; remainingQuantity: string }[];
  observedAt: string;
  identityWarnings: string[];
  hasHistoricalIdentities: boolean;
};
export type CoverageApproval = {
  id: string;
  requestKey: string;
  fingerprint: string;
  allocations: CoverageAllocation[];
  createdAt: string;
  replayed: boolean;
};

// Compare exact decimal text without converting stock or prices to floating point.
export function coverageDecimal(value: unknown): bigint | null {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value)
  )
    return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
export function coveragePriceDiffers(
  receipt: CoverageReceipt,
  bill: CoverageBillLine,
) {
  return (
    coverageRateDiffers(receipt.unitCost, bill.unitCost) &&
    !coverageRoundingProven(receipt, bill)
  );
}
export function coverageRoundingProven(
  receipt: CoverageReceipt,
  bill: CoverageBillLine,
) {
  return verifyCoverageRoundingEvidence(
    bill.roundingSource
      ? { ...bill.roundingSource, receiptStockUnitCost: receipt.unitCost }
      : undefined,
    receipt.unitCost,
    bill.unitCost,
    bill.quantity,
  );
}
export function coveragePreviewRoundingProven(
  line: CoveragePreview["lines"][number],
) {
  return (
    line.varianceClassification === "unit_conversion_rounding" &&
    verifyCoverageRoundingEvidence(
      line.roundingEvidence,
      line.receipt.unitCost,
      line.bill.unitCost,
      line.bill.quantity,
    )
  );
}
export function coverageRateDiffers(receiptCost: string, billedCost: string) {
  const left = coverageDecimal(receiptCost),
    right = coverageDecimal(billedCost);
  return left === null || right === null || left !== right;
}
/** Display only. Half a cent rounds away from zero; financial review always
 * uses exact source evidence rather than this rounded label. */
export function coverageUsd(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 70 ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value)
  )
    return "Amount unavailable";
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const units =
    BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, "0"));
  const cents = (units + 5_000_000_000n) / 10_000_000_000n;
  const dollars = String(cents / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative && cents !== 0n ? "-" : ""}$${dollars}.${String(cents % 100n).padStart(2, "0")}`;
}
export function coverageRejected(
  error: unknown,
): error is Error & { status: number } {
  if (!(error instanceof Error) || error.name !== "ApiError") return false;
  const status = Object.getOwnPropertyDescriptor(error, "status")?.value;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408
  );
}
export const billOriginalTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);
export const billOriginalMaxBytes = 10 * 1024 * 1024;
export async function uploadBillOriginal(file: File, billId: string) {
  if (
    !file.size ||
    file.size > billOriginalMaxBytes ||
    !billOriginalTypes.has(file.type)
  )
    throw new Error("Choose a PDF, JPEG or PNG up to 10 MiB.");
  return customFetch<{ objectPath: string }>(
    `/api/storage/files/vendor-bill-document?recordId=${encodeURIComponent(billId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
      },
      body: file,
      responseType: "json",
    },
  );
}
export function billOriginalDownload(document: BillDocument, billId: string) {
  if (document.billId !== billId) return null;
  const expected = `/api/quickbooks/vendor-bills/documents/${encodeURIComponent(document.id)}/download`;
  return document.downloadUrl === expected ? expected : null;
}
