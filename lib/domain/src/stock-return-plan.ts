import { coverageDecimal, coverageMicros } from "./bill-receipt-coverage";
import {
  verifyCoverageRoundingEvidence,
  type CoverageRoundingEvidence,
} from "./coverage-rounding";

/** Server-normalized, already verified evidence. Never accept these DTOs or their
 * completeness flags directly from a client. This module performs no I/O and
 * produces no financial/provider request document. */
export interface ReturnPlanSnapshot {
  expectedFingerprint: string;
  currentFingerprint: string;
}
export interface ReturnPlanCompany {
  connectionId: string;
  realmId: string;
  environment: "sandbox" | "production";
  currency: string;
}
export interface ReturnPlanProviderProof extends ReturnPlanSnapshot {
  verified: true;
  connectionId: string;
  realmId: string;
  environment: "sandbox" | "production";
  itemId: string;
  documentId: string;
}
export interface ReturnPlanReceipt {
  id: string;
  receiptId: string;
  orderId: string;
  movementId: string;
  productId: string;
  stockUnit: string;
  source: "purchase_order" | "opening" | "catalog" | "reviewed_opening";
  supplierKey: string;
  acceptedQuantity: string;
  allocatedQuantity: string;
  providerBoundQuantity: string;
  acquisitionUnitCost: string;
  snapshot: ReturnPlanSnapshot;
}
export interface ReturnPlanBillLine {
  key: string;
  billQueueId: string;
  billLineIndex: number;
  providerBillId: string;
  vendorId: string;
  supplierKey: string;
  itemId: string;
  productId: string;
  stockUnit: string;
  currency: string;
  quantity: string;
  boundQuantity: string;
  billedUnitCost: string;
  active: true;
  proof: ReturnPlanProviderProof;
}
export interface ReturnPlanBinding {
  id: string;
  receiptLineId: string;
  billLineKey: string;
  quantity: string;
  base: {
    id: string;
    receiptLineId: string;
    productId: string;
    stockUnit: string;
    quantity: string;
    providerBoundQuantity: string;
    receiptUnitCost: string;
    snapshot: ReturnPlanSnapshot;
  };
  receiptSourceFingerprint: string;
  billSourceFingerprint: string;
  varianceNote: string;
  varianceClassification:
    | "none"
    | "unit_conversion_rounding"
    | "price_variance";
  roundingEvidence: CoverageRoundingEvidence | null;
  snapshot: ReturnPlanSnapshot;
}
export interface ReturnPlanSlice {
  source: "purchase_order" | "opening" | "catalog" | "reviewed_opening";
  receiptLineId: string;
  movementId: string;
  quantity: string;
  acquisitionUnitCost: string;
}
export interface ReturnPlanMovement {
  id: string;
  jobId: string;
  productId: string;
  stockUnit: string;
  quantity: string;
  kind: "consume" | "return";
  /** Canonically grouped by receipt line. Retain raw slice evidence in snapshot. */
  slices: ReturnPlanSlice[];
  snapshot: ReturnPlanSnapshot;
}
export interface ReturnPlanReturnedMovement extends ReturnPlanMovement {
  issueId: string;
}
export interface ReturnPlanInvoice {
  id: string;
  jobId: string;
  customerId: string;
  providerCustomerId: string;
  providerInvoiceId: string;
  currency: string;
  active: true;
  voided: false;
  linkedTransactionsComplete: true;
  /** Actual current linked documents, including their item lines. A credit/refund
   * remains manual; this planner never infers whether it restored inventory. */
  linkedDocuments: Array<{
    id: string;
    type: string;
    itemLines: Array<{ itemId: string; quantity: string }>;
  }>;
  lines: Array<{
    id: string;
    productId: string;
    stockUnit: string;
    itemId: string;
    detailType: "Inventory" | "Service" | "NonInventory";
    localQuantity: string;
    remoteQuantity: string;
    localUnitPrice: string;
    remoteUnitPrice: string;
  }>;
  proof: ReturnPlanProviderProof;
}
export interface ReturnPlanPriorClaim {
  id: string;
  origin: "legacy_auto" | "manual_case";
  state:
    | "pending"
    | "submitted"
    | "unknown"
    | "confirmed"
    | "cancelled_unsubmitted"
    | "rejected_unsubmitted";
  jobId: string;
  productId: string;
  realmId: string;
  environment: "sandbox" | "production";
  returns: Array<{ returnId: string; quantity: string }>;
  neverSubmitted: boolean;
  adjustment: {
    id: string;
    quantity: string;
    sourceReferenceVerified: true;
    verifiedClaimId: string;
    verifiedReturnIds: string[];
    proof: ReturnPlanProviderProof;
  } | null;
  snapshot: ReturnPlanSnapshot;
}
export interface StockReturnPlanInput {
  company: ReturnPlanCompany;
  customerId: string;
  providerCustomerId: string;
  jobId: string;
  productId: string;
  itemId: string;
  stockUnit: string;
  scope: ReturnPlanSnapshot & {
    allIssueSourcesIncluded: true;
    allJobReturnsIncluded: true;
    allPriorClaimsIncluded: true;
    invoiceRefundLookupsComplete: true;
  };
  quantity: {
    worksTotalIncludingTransit: string;
    quickBooksOnHand: string;
    itemActive: true;
    itemType: "Inventory";
    trackQtyOnHand: true;
    proof: ReturnPlanProviderProof;
  };
  receipts: ReturnPlanReceipt[];
  billLines: ReturnPlanBillLine[];
  bindings: ReturnPlanBinding[];
  issues: ReturnPlanMovement[];
  returns: ReturnPlanReturnedMovement[];
  selectedReturnIds: string[];
  invoices: ReturnPlanInvoice[];
  priorClaims: ReturnPlanPriorClaim[];
}
export type StockReturnPlanReason =
  | "invalid_evidence"
  | "stale_scope"
  | "incomplete_scope"
  | "wrong_company_or_item"
  | "unsupported_inventory_state"
  | "duplicate_identity"
  | "unsupported_source"
  | "receipt_bill_coverage_unverified"
  | "receipt_bill_coverage_overallocated"
  | "source_quantity_mismatch"
  | "source_cost_mismatch"
  | "variance_review_missing"
  | "return_quantity_invalid"
  | "invoice_quantity_mismatch"
  | "invoice_credit_or_refund"
  | "prior_claim_unresolved"
  | "prior_claim_overallocated"
  | "return_already_accounted"
  | "unselected_unclaimed_return"
  | "quantity_difference_unexplained";
export type StockReturnPlan =
  | {
      kind: "ready_quantity_plan";
      quantityDifference: string;
      returnIds: string[];
      returnQuantities: Array<{ returnId: string; quantity: string }>;
      invoiceIds: string[];
      sourceRefs: Record<string, string[]>;
      scopeFingerprint: string;
      warnings: string[];
      providerSubmissionAllowed: false;
      financialActionsAllowed: false;
      revaluesInventory: false;
    }
  | {
      kind: "manual_review";
      reasonCodes: StockReturnPlanReason[];
      explanations: string[];
      providerSubmissionAllowed: false;
      financialActionsAllowed: false;
      revaluesInventory: false;
    };

class Refusal extends Error {
  constructor(
    readonly reason: StockReturnPlanReason,
    message: string,
  ) {
    super(message);
  }
}
function requireEvidence(
  value: unknown,
  reason: StockReturnPlanReason,
  explanation: string,
): asserts value {
  if (!value) throw new Refusal(reason, explanation);
}
function identity(value: unknown) {
  requireEvidence(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 200 &&
      !/[\s\u0000-\u001f\u007f]/.test(value),
    "invalid_evidence",
    "A bounded exact source identity is missing or invalid.",
  );
}
function snapshot(value: ReturnPlanSnapshot) {
  requireEvidence(
    value &&
      /^[a-f0-9]{64}$/.test(value.expectedFingerprint) &&
      value.expectedFingerprint === value.currentFingerprint,
    "stale_scope",
    "Saved source evidence is missing or changed. Refresh and review the exact current sources.",
  );
}
function unique<T>(items: T[], key: (item: T) => string) {
  requireEvidence(
    Array.isArray(items) && items.length <= 1000,
    "invalid_evidence",
    "The evidence list is missing or exceeds this bounded planner.",
  );
  const result = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    identity(id);
    requireEvidence(
      !result.has(id),
      "duplicate_identity",
      "A source, bill, movement, invoice or claim identity appears more than once.",
    );
    result.set(id, item);
  }
  return result;
}
const sum = (map: Map<string, bigint>, key: string, quantity: bigint) =>
  map.set(key, (map.get(key) ?? 0n) + quantity);
const positive = (value: string) => {
  const units = coverageMicros(value);
  requireEvidence(
    units > 0n,
    "source_quantity_mismatch",
    "A source quantity must be positive and exact to six decimal places.",
  );
  return units;
};
const stable = (values: Iterable<string>) => [...new Set(values)].sort();

/** Quantity planning only. A ready result is not an adjustment, supplier credit,
 * customer refund, journal entry, stock revaluation or provider confirmation. The
 * eventual API must re-read/lock all sources and claims before reserving a case. */
export function planStockReturns(input: StockReturnPlanInput): StockReturnPlan {
  try {
    identity(input.jobId);
    identity(input.productId);
    identity(input.itemId);
    identity(input.customerId);
    identity(input.providerCustomerId);
    requireEvidence(
      typeof input.stockUnit === "string" &&
        input.stockUnit.trim().length > 0 &&
        input.stockUnit.length <= 100 &&
        !/[\u0000-\u001f\u007f]/.test(input.stockUnit),
      "invalid_evidence",
      "Retain a valid exact stock unit without inferring a conversion.",
    );
    identity(input.company.connectionId);
    identity(input.company.realmId);
    requireEvidence(
      ["sandbox", "production"].includes(input.company.environment) &&
        /^[A-Z]{3}$/.test(input.company.currency),
      "wrong_company_or_item",
      "The actual connected company, environment and currency must be verified.",
    );
    snapshot(input.scope);
    requireEvidence(
      input.scope.allIssueSourcesIncluded === true &&
        input.scope.allJobReturnsIncluded === true &&
        input.scope.allPriorClaimsIncluded === true &&
        input.scope.invoiceRefundLookupsComplete === true,
      "incomplete_scope",
      "All relevant issues, returns, prior claims and current invoice/refund lookups are required; a partial list cannot establish a quantity plan.",
    );
    const provider = (proof: ReturnPlanProviderProof, documentId: string) => {
      snapshot(proof);
      requireEvidence(
        proof.verified === true &&
          proof.connectionId === input.company.connectionId &&
          proof.realmId === input.company.realmId &&
          proof.environment === input.company.environment &&
          proof.itemId === input.itemId &&
          proof.documentId === documentId,
        "wrong_company_or_item",
        "Provider evidence must come from the current owner-selected connection and exact company, environment and inventory item.",
      );
    };
    provider(input.quantity.proof, input.itemId);
    requireEvidence(
      input.quantity.itemActive === true &&
        input.quantity.itemType === "Inventory" &&
        input.quantity.trackQtyOnHand === true,
      "unsupported_inventory_state",
      "An active quantity-tracked inventory item must be verified; service or unverified item stock is not inferred.",
    );
    const localQuantity = coverageMicros(
        input.quantity.worksTotalIncludingTransit,
      ),
      remoteQuantity = coverageMicros(input.quantity.quickBooksOnHand);
    const receipts = unique(input.receipts, (row) => row.id),
      bills = unique(input.billLines, (row) => row.key),
      bindings = unique(input.bindings, (row) => row.id);
    const issues = unique(input.issues, (row) => row.id),
      returns = unique(input.returns, (row) => row.id),
      invoices = unique(input.invoices, (row) => row.id),
      claims = unique(input.priorClaims, (row) => row.id);
    requireEvidence(
      issues.size && returns.size && invoices.size && bindings.size,
      "incomplete_scope",
      "Actual receipt-backed issues, returns, provider bill coverage and customer inventory invoices are required.",
    );
    const providerInvoiceIds = new Set<string>(),
      billReferences = new Set<string>(),
      movementIds = new Set<string>();
    for (const receipt of receipts.values()) {
      snapshot(receipt.snapshot);
      identity(receipt.receiptId);
      identity(receipt.orderId);
      identity(receipt.movementId);
      requireEvidence(
        !movementIds.has(receipt.movementId),
        "duplicate_identity",
        "One receipt stock movement cannot represent two different accepted receipt lines.",
      );
      movementIds.add(receipt.movementId);
      requireEvidence(
        receipt.source === "purchase_order",
        "unsupported_source",
        "Opening, catalog or manually reviewed opening sources do not establish purchased receipt stock.",
      );
      requireEvidence(
        receipt.productId === input.productId &&
          receipt.stockUnit === input.stockUnit,
        "wrong_company_or_item",
        "Every receipt must retain the exact product and stock unit.",
      );
      const quantity = positive(receipt.acceptedQuantity),
        allocated = coverageMicros(receipt.allocatedQuantity),
        bound = coverageMicros(receipt.providerBoundQuantity);
      coverageMicros(receipt.acquisitionUnitCost);
      requireEvidence(
        bound <= allocated && allocated <= quantity,
        "receipt_bill_coverage_overallocated",
        "Receipt coverage must consume physical accepted quantity only once; damaged quantities or provider endorsements cannot create capacity.",
      );
    }
    for (const bill of bills.values()) {
      provider(bill.proof, bill.providerBillId);
      identity(bill.billQueueId);
      identity(bill.providerBillId);
      identity(bill.vendorId);
      const canonical = JSON.stringify([
        bill.providerBillId,
        bill.billLineIndex,
      ]);
      requireEvidence(
        Number.isSafeInteger(bill.billLineIndex) &&
          bill.billLineIndex >= 0 &&
          bill.billLineIndex < 50 &&
          !billReferences.has(canonical),
        "duplicate_identity",
        "A provider merchandise line must have one exact bill/index identity; duplicate queue records cannot count it twice.",
      );
      billReferences.add(canonical);
      requireEvidence(
        bill.active === true &&
          bill.productId === input.productId &&
          bill.itemId === input.itemId &&
          bill.stockUnit === input.stockUnit &&
          bill.currency === input.company.currency,
        "wrong_company_or_item",
        "The current active bill line must match the product, item, stock unit and company currency without conversion.",
      );
      requireEvidence(
        coverageMicros(bill.boundQuantity) <= positive(bill.quantity),
        "receipt_bill_coverage_overallocated",
        "Provider bindings exceed the actual stock-converted bill merchandise quantity.",
      );
      coverageMicros(bill.billedUnitCost);
    }
    const byReceipt = new Map<string, bigint>(),
      byBill = new Map<string, bigint>(),
      byBase = new Map<string, bigint>(),
      bases = new Map<string, ReturnPlanBinding["base"]>(),
      warnings = new Set<string>();
    for (const binding of bindings.values()) {
      snapshot(binding.snapshot);
      snapshot(binding.base.snapshot);
      identity(binding.base.id);
      const receipt = receipts.get(binding.receiptLineId),
        bill = bills.get(binding.billLineKey);
      requireEvidence(
        receipt &&
          bill &&
          binding.base.receiptLineId === receipt.id &&
          binding.base.productId === input.productId &&
          binding.base.stockUnit === input.stockUnit &&
          binding.receiptSourceFingerprint ===
            receipt.snapshot.currentFingerprint &&
          binding.billSourceFingerprint === bill.proof.currentFingerprint &&
          receipt.supplierKey === bill.supplierKey,
        "receipt_bill_coverage_unverified",
        "Every provider endorsement must retain the exact accepted receipt, base allocation and current immutable bill source.",
      );
      requireEvidence(
        coverageMicros(binding.base.receiptUnitCost) ===
          coverageMicros(receipt.acquisitionUnitCost),
        "source_cost_mismatch",
        "A provider endorsement cannot rewrite the original receipt acquisition cost.",
      );
      const previous = bases.get(binding.base.id);
      requireEvidence(
        !previous || JSON.stringify(previous) === JSON.stringify(binding.base),
        "receipt_bill_coverage_unverified",
        "One physical base allocation has inconsistent immutable evidence.",
      );
      bases.set(binding.base.id, binding.base);
      const quantity = positive(binding.quantity);
      positive(binding.base.quantity);
      sum(byReceipt, receipt.id, quantity);
      sum(byBill, bill.key, quantity);
      sum(byBase, binding.base.id, quantity);
      if (
        coverageMicros(receipt.acquisitionUnitCost) !==
        coverageMicros(bill.billedUnitCost)
      ) {
        if (binding.varianceClassification === "unit_conversion_rounding") {
          requireEvidence(
            verifyCoverageRoundingEvidence(
              binding.roundingEvidence,
              receipt.acquisitionUnitCost,
              bill.billedUnitCost,
              bill.quantity,
            ),
            "variance_review_missing",
            "A conversion-rounding classification needs the exact retained approved buy price/factor/quantity and printed-line arithmetic proof; a label alone is insufficient.",
          );
          warnings.add(
            "A retained approved unit conversion explains the one-micro rate rounding difference. Original receipt/bill rates and printed amounts remain unchanged; this is not revaluation.",
          );
        } else {
          requireEvidence(
            binding.varianceClassification === "price_variance" &&
              typeof binding.varianceNote === "string" &&
              binding.varianceNote.trim().length >= 10 &&
              binding.varianceNote.length <= 500,
            "variance_review_missing",
            "Different receipt and billed costs require retained explicit variance review, never an inferred revaluation.",
          );
          warnings.add(
            "Receipt acquisition cost and billed cost differ. Both original rates remain evidence; this quantity plan does not revalue inventory or change job costs.",
          );
        }
      } else
        requireEvidence(
          binding.varianceClassification === "none",
          "variance_review_missing",
          "A saved variance classification no longer matches the exact source rates.",
        );
    }
    for (const receipt of receipts.values())
      requireEvidence(
        (byReceipt.get(receipt.id) ?? 0n) ===
          coverageMicros(receipt.providerBoundQuantity),
        "receipt_bill_coverage_unverified",
        "All provider endorsements for each relevant receipt must be included; a partial list cannot prove coverage.",
      );
    for (const [id, base] of bases)
      requireEvidence(
        byBase.get(id) === coverageMicros(base.providerBoundQuantity) &&
          coverageMicros(base.providerBoundQuantity) <= positive(base.quantity),
        "receipt_bill_coverage_overallocated",
        "Provider bindings across all companies must not consume a base allocation twice.",
      );
    for (const [id, quantity] of byBill)
      requireEvidence(
        quantity <= coverageMicros(bills.get(id)!.boundQuantity),
        "receipt_bill_coverage_overallocated",
        "The selected endorsements exceed the bill line's complete recorded bindings.",
      );
    const issuedByReceipt = new Map<string, bigint>(),
      issueSlices = new Map<string, Map<string, bigint>>();
    const slices = (movement: ReturnPlanMovement) => {
      snapshot(movement.snapshot);
      requireEvidence(
        movement.jobId === input.jobId &&
          movement.productId === input.productId &&
          movement.stockUnit === input.stockUnit,
        "wrong_company_or_item",
        "An issue or return belongs to another job, product or stock unit.",
      );
      requireEvidence(
        Array.isArray(movement.slices) &&
          movement.slices.length > 0 &&
          movement.slices.length <= 1000,
        "incomplete_scope",
        "The saved movement needs its complete canonical receipt-source slices.",
      );
      const result = new Map<string, bigint>();
      let total = 0n;
      for (const slice of movement.slices) {
        const receipt = receipts.get(slice.receiptLineId);
        requireEvidence(
          slice.source === "purchase_order" &&
            receipt &&
            slice.movementId === receipt.movementId,
          "unsupported_source",
          "Every movement slice must identify its actual purchase receipt stock movement; opening or guessed sources remain manual.",
        );
        requireEvidence(
          !result.has(receipt.id),
          "duplicate_identity",
          "Canonical movement slices must be grouped once per original receipt; raw duplicate slices are not guessed or merged.",
        );
        requireEvidence(
          coverageMicros(slice.acquisitionUnitCost) ===
            coverageMicros(receipt.acquisitionUnitCost),
          "source_cost_mismatch",
          "A movement's saved cost slice differs from the original receipt cost.",
        );
        const quantity = positive(slice.quantity);
        result.set(receipt.id, quantity);
        total += quantity;
      }
      requireEvidence(
        total === positive(movement.quantity),
        "source_quantity_mismatch",
        "Saved source slices must explain the entire movement quantity exactly.",
      );
      return result;
    };
    let issued = 0n;
    for (const issue of issues.values()) {
      requireEvidence(
        issue.kind === "consume" && !movementIds.has(issue.id),
        "unsupported_source",
        "An issue must be the actual consume movement, distinct from its original receipt stock movement.",
      );
      const sources = slices(issue);
      issueSlices.set(issue.id, sources);
      issued += positive(issue.quantity);
      for (const [id, quantity] of sources) sum(issuedByReceipt, id, quantity);
    }
    for (const [id, quantity] of issuedByReceipt)
      requireEvidence(
        quantity <= (byReceipt.get(id) ?? 0n),
        "receipt_bill_coverage_unverified",
        "All original issued quantities must be covered by actual verified receipt-to-bill endorsements; unbilled or repeated unsupported source cycles remain manual.",
      );
    const returnedByIssue = new Map<string, bigint>(),
      returnedByIssueReceipt = new Map<string, bigint>();
    for (const returned of returns.values()) {
      requireEvidence(
        returned.kind === "return" && !movementIds.has(returned.id),
        "unsupported_source",
        "The selected returned stock must be an actual saved return movement, not a receipt or issue alias.",
      );
      requireEvidence(
        !issues.has(returned.id),
        "duplicate_identity",
        "A return cannot also be its original issue identity.",
      );
      const original = issues.get(returned.issueId),
        originalSlices = issueSlices.get(returned.issueId);
      requireEvidence(
        original && originalSlices,
        "return_quantity_invalid",
        "Each return must retain its specific original job issue.",
      );
      const returnedSlices = slices(returned);
      sum(returnedByIssue, returned.issueId, positive(returned.quantity));
      requireEvidence(
        returnedByIssue.get(returned.issueId)! <= positive(original.quantity),
        "return_quantity_invalid",
        "Cumulative returns exceed their original issue quantity.",
      );
      for (const [receipt, quantity] of returnedSlices) {
        const key = JSON.stringify([returned.issueId, receipt]);
        sum(returnedByIssueReceipt, key, quantity);
        requireEvidence(
          returnedByIssueReceipt.get(key)! <=
            (originalSlices.get(receipt) ?? 0n),
          "return_quantity_invalid",
          "Returned receipt slices exceed or differ from the original issue's saved sources.",
        );
      }
    }
    let invoiced = 0n;
    for (const invoice of invoices.values()) {
      provider(invoice.proof, invoice.providerInvoiceId);
      identity(invoice.providerInvoiceId);
      identity(invoice.customerId);
      requireEvidence(
        !providerInvoiceIds.has(invoice.providerInvoiceId),
        "duplicate_identity",
        "The same provider customer invoice cannot be counted twice through different local records.",
      );
      providerInvoiceIds.add(invoice.providerInvoiceId);
      requireEvidence(
        invoice.jobId === input.jobId &&
          invoice.customerId === input.customerId &&
          invoice.providerCustomerId === input.providerCustomerId &&
          invoice.currency === input.company.currency &&
          invoice.active === true &&
          invoice.voided === false &&
          invoice.linkedTransactionsComplete === true,
        "invoice_quantity_mismatch",
        "Current active same-job invoices and complete linked-document lookups are required.",
      );
      requireEvidence(
        Array.isArray(invoice.linkedDocuments) &&
          !invoice.linkedDocuments.some((document) =>
            ["CreditMemo", "RefundReceipt"].includes(document.type),
          ),
        "invoice_credit_or_refund",
        "A linked credit memo or refund requires separate accounting review; whether it restored stock is never inferred.",
      );
      requireEvidence(
        Array.isArray(invoice.lines) &&
          invoice.lines.length > 0 &&
          invoice.lines.length <= 1000,
        "invoice_quantity_mismatch",
        "A service-only or missing customer item line cannot prove an inventory issue.",
      );
      unique(invoice.lines, (line) => line.id);
      for (const line of invoice.lines) {
        requireEvidence(
          line.productId === input.productId &&
            line.itemId === input.itemId &&
            line.stockUnit === input.stockUnit &&
            line.detailType === "Inventory",
          "invoice_quantity_mismatch",
          "Customer invoice lines must use the exact mapped inventory item and stock unit; service substitutes are unsupported.",
        );
        const quantity = positive(line.localQuantity);
        requireEvidence(
          quantity === positive(line.remoteQuantity) &&
            coverageMicros(line.localUnitPrice) ===
              coverageMicros(line.remoteUnitPrice),
          "invoice_quantity_mismatch",
          "Actual provider item quantities and rates must match the saved customer invoice lines.",
        );
        invoiced += quantity;
      }
    }
    requireEvidence(
      invoiced === issued,
      "invoice_quantity_mismatch",
      "The actual selected customer inventory invoice quantities must equal all original issued stock for this job and product.",
    );
    const claimed = new Map<string, bigint>(),
      adjustmentIds = new Set<string>(),
      confirmedClaims: string[] = [];
    for (const claim of claims.values()) {
      snapshot(claim.snapshot);
      requireEvidence(
        ["legacy_auto", "manual_case"].includes(claim.origin) &&
          claim.jobId === input.jobId &&
          claim.productId === input.productId &&
          claim.realmId === input.company.realmId &&
          claim.environment === input.company.environment,
        "wrong_company_or_item",
        "All old and new adjustment claims must retain this exact job, product and provider company.",
      );
      requireEvidence(
        !["pending", "submitted", "unknown"].includes(claim.state),
        "prior_claim_unresolved",
        "An earlier pending, submitted or unknown return claim must be reconciled before another quantity plan.",
      );
      const allocations = unique(
        claim.returns,
        (allocation) => allocation.returnId,
      );
      requireEvidence(
        allocations.size > 0,
        "prior_claim_unresolved",
        "A prior claim must retain its exact original return quantities.",
      );
      if (
        ["cancelled_unsubmitted", "rejected_unsubmitted"].includes(claim.state)
      ) {
        requireEvidence(
          claim.neverSubmitted === true && claim.adjustment === null,
          "prior_claim_unresolved",
          "A cancelled or rejected claim frees no capacity unless never submitted is proven and no provider adjustment exists.",
        );
        for (const allocation of allocations.values())
          requireEvidence(
            returns.has(allocation.returnId) &&
              positive(allocation.quantity) <=
                positive(returns.get(allocation.returnId)!.quantity),
            "prior_claim_overallocated",
            "A cancelled claim has invalid retained return evidence.",
          );
        continue;
      }
      requireEvidence(
        claim.state === "confirmed" &&
          claim.adjustment &&
          claim.neverSubmitted === false,
        "prior_claim_unresolved",
        "A prior claim's current provider outcome is not confirmed.",
      );
      provider(claim.adjustment.proof, claim.adjustment.id);
      identity(claim.adjustment.id);
      requireEvidence(
        !adjustmentIds.has(claim.adjustment.id),
        "duplicate_identity",
        "One actual provider adjustment cannot confirm two different retained claims.",
      );
      adjustmentIds.add(claim.adjustment.id);
      requireEvidence(
        claim.adjustment.sourceReferenceVerified === true &&
          claim.adjustment.verifiedClaimId === claim.id &&
          JSON.stringify(stable(claim.adjustment.verifiedReturnIds)) ===
            JSON.stringify(stable(allocations.keys())),
        "prior_claim_unresolved",
        "The provider adjustment must retain the exact original claim and source return references, not merely a coincident quantity.",
      );
      let total = 0n;
      for (const allocation of allocations.values()) {
        const returned = returns.get(allocation.returnId);
        requireEvidence(
          returned,
          "prior_claim_unresolved",
          "A prior adjustment references a missing original return.",
        );
        const quantity = positive(allocation.quantity);
        sum(claimed, returned.id, quantity);
        total += quantity;
        requireEvidence(
          claimed.get(returned.id)! <= positive(returned.quantity),
          "prior_claim_overallocated",
          "Prior confirmed claims already exceed the original returned quantity.",
        );
      }
      requireEvidence(
        total === positive(claim.adjustment.quantity),
        "prior_claim_overallocated",
        "The exact actual provider adjustment must equal its retained per-return claims.",
      );
      confirmedClaims.push(claim.id);
    }
    const selected = unique(input.selectedReturnIds, (id) => id);
    requireEvidence(
      selected.size > 0,
      "return_quantity_invalid",
      "Explicitly select at least one unclaimed original return.",
    );
    let pending = 0n;
    const returnQuantities: Array<{ returnId: string; quantity: string }> = [];
    for (const returned of returns.values()) {
      const remaining =
        positive(returned.quantity) - (claimed.get(returned.id) ?? 0n);
      requireEvidence(
        selected.has(returned.id) || remaining === 0n,
        "unselected_unclaimed_return",
        "Another unclaimed return remains in this complete job/product scope. Review every unresolved return rather than explain the difference with a partial selection.",
      );
      if (selected.has(returned.id)) {
        requireEvidence(
          remaining > 0n,
          "return_already_accounted",
          "A selected return has already been fully accounted for by confirmed adjustments.",
        );
        pending += remaining;
        returnQuantities.push({
          returnId: returned.id,
          quantity: coverageDecimal(remaining),
        });
      }
    }
    for (const id of selected.keys())
      requireEvidence(
        returns.has(id),
        "return_quantity_invalid",
        "A selected return is missing from the complete verified source set.",
      );
    requireEvidence(
      pending > 0n && localQuantity - remoteQuantity === pending,
      "quantity_difference_unexplained",
      "The current total Works stock (including transit) minus actual QuickBooks stock must equal precisely the selected unclaimed returns. Other differences remain manual.",
    );
    warnings.add(
      "Quantity planning only: re-read and lock all sources and old/new claims before reserving a reviewed case. This result does not permit a provider submission.",
    );
    warnings.add(
      "No opening balance, FIFO valuation, COGS journal entry, supplier credit, customer refund, payment or inventory revaluation is created or inferred from a job stock return.",
    );
    return {
      kind: "ready_quantity_plan",
      quantityDifference: coverageDecimal(pending),
      returnIds: returnQuantities.map((row) => row.returnId).sort(),
      returnQuantities: returnQuantities.sort((left, right) =>
        left.returnId.localeCompare(right.returnId),
      ),
      invoiceIds: stable(invoices.keys()),
      sourceRefs: {
        receiptLineIds: stable(issuedByReceipt.keys()),
        receiptIds: stable([...receipts.values()].map((row) => row.receiptId)),
        receiptMovementIds: stable(
          [...receipts.values()].map((row) => row.movementId),
        ),
        orderIds: stable([...receipts.values()].map((row) => row.orderId)),
        baseAllocationIds: stable(bases.keys()),
        providerBindingIds: stable(bindings.keys()),
        billQueueIds: stable([...bills.values()].map((row) => row.billQueueId)),
        providerBillIds: stable(
          [...bills.values()].map((row) => row.providerBillId),
        ),
        issueIds: stable(issues.keys()),
        providerInvoiceIds: stable(providerInvoiceIds),
        confirmedClaimIds: stable(confirmedClaims),
        providerAdjustmentIds: stable(adjustmentIds),
      },
      scopeFingerprint: input.scope.currentFingerprint,
      warnings: [...warnings],
      providerSubmissionAllowed: false,
      financialActionsAllowed: false,
      revaluesInventory: false,
    };
  } catch (error) {
    const refusal =
      error instanceof Refusal
        ? error
        : new Refusal(
            "invalid_evidence",
            "Evidence is missing, malformed or outside the exact supported decimal range. Keep this case in manual review.",
          );
    return {
      kind: "manual_review",
      reasonCodes: [refusal.reason],
      explanations: [refusal.message],
      providerSubmissionAllowed: false,
      financialActionsAllowed: false,
      revaluesInventory: false,
    };
  }
}
