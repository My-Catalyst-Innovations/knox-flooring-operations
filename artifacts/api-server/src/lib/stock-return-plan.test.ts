import { describe, expect, it } from "vitest";
import {
  planStockReturns,
  type StockReturnPlanInput,
  type ReturnPlanProviderProof,
  type StockReturnPlanReason,
} from "@workspace/domain";
const fp = "a".repeat(64),
  snapshot = () => ({ expectedFingerprint: fp, currentFingerprint: fp });
const company = {
  connectionId: "connection-current",
  realmId: "123456789",
  environment: "sandbox" as const,
  currency: "USD",
};
const proof = (documentId: string): ReturnPlanProviderProof => ({
  ...snapshot(),
  ...company,
  itemId: "1001",
  documentId,
  verified: true,
});
function fixture(): StockReturnPlanInput {
  const receipts = [
    {
      id: "r1",
      receiptId: "receipt1",
      orderId: "po1",
      movementId: "movement1",
      productId: "product",
      stockUnit: "sqft",
      supplierKey: "supplier",
      source: "purchase_order" as const,
      acceptedQuantity: "6",
      allocatedQuantity: "6",
      providerBoundQuantity: "6",
      acquisitionUnitCost: "2.000001",
      snapshot: snapshot(),
    },
    {
      id: "r2",
      receiptId: "receipt2",
      orderId: "po2",
      movementId: "movement2",
      productId: "product",
      stockUnit: "sqft",
      supplierKey: "supplier",
      source: "purchase_order" as const,
      acceptedQuantity: "4",
      allocatedQuantity: "4",
      providerBoundQuantity: "4",
      acquisitionUnitCost: "2.000001",
      snapshot: snapshot(),
    },
  ];
  const billLines = [
    {
      key: "b1:0",
      billQueueId: "b1",
      billLineIndex: 0,
      providerBillId: "2001",
      vendorId: "3001",
      supplierKey: "supplier",
      itemId: "1001",
      productId: "product",
      stockUnit: "sqft",
      currency: "USD",
      quantity: "3",
      boundQuantity: "3",
      billedUnitCost: "2.000001",
      active: true as const,
      proof: proof("2001"),
    },
    {
      key: "b2:0",
      billQueueId: "b2",
      billLineIndex: 0,
      providerBillId: "2002",
      vendorId: "3001",
      supplierKey: "supplier",
      itemId: "1001",
      productId: "product",
      stockUnit: "sqft",
      currency: "USD",
      quantity: "7",
      boundQuantity: "7",
      billedUnitCost: "2.000001",
      active: true as const,
      proof: proof("2002"),
    },
  ];
  const base1 = {
    id: "base1",
    receiptLineId: "r1",
    productId: "product",
    stockUnit: "sqft",
    quantity: "6",
    providerBoundQuantity: "6",
    receiptUnitCost: "2.000001",
    snapshot: snapshot(),
  };
  const base2 = {
    id: "base2",
    receiptLineId: "r2",
    productId: "product",
    stockUnit: "sqft",
    quantity: "4",
    providerBoundQuantity: "4",
    receiptUnitCost: "2.000001",
    snapshot: snapshot(),
  };
  const bindings = [
    {
      id: "bind1",
      receiptLineId: "r1",
      billLineKey: "b1:0",
      quantity: "3",
      base: structuredClone(base1),
      receiptSourceFingerprint: fp,
      billSourceFingerprint: fp,
      varianceNote: "",
      varianceClassification: "none" as const,
      roundingEvidence: null,
      snapshot: snapshot(),
    },
    {
      id: "bind2",
      receiptLineId: "r1",
      billLineKey: "b2:0",
      quantity: "3",
      base: structuredClone(base1),
      receiptSourceFingerprint: fp,
      billSourceFingerprint: fp,
      varianceNote: "",
      varianceClassification: "none" as const,
      roundingEvidence: null,
      snapshot: snapshot(),
    },
    {
      id: "bind3",
      receiptLineId: "r2",
      billLineKey: "b2:0",
      quantity: "4",
      base: structuredClone(base2),
      receiptSourceFingerprint: fp,
      billSourceFingerprint: fp,
      varianceNote: "",
      varianceClassification: "none" as const,
      roundingEvidence: null,
      snapshot: snapshot(),
    },
  ];
  const slice = (
    receiptLineId: string,
    movementId: string,
    quantity: string,
  ) => ({
    source: "purchase_order" as const,
    receiptLineId,
    movementId,
    quantity,
    acquisitionUnitCost: "2.000001",
  });
  const movement = (
    id: string,
    quantity: string,
    slices: ReturnType<typeof slice>[],
  ) => ({
    id,
    jobId: "job",
    productId: "product",
    stockUnit: "sqft",
    quantity,
    kind: "consume" as const,
    slices,
    snapshot: snapshot(),
  });
  const line = (id: string, quantity: string) => ({
    id,
    productId: "product",
    stockUnit: "sqft",
    itemId: "1001",
    detailType: "Inventory" as const,
    localQuantity: quantity,
    remoteQuantity: quantity,
    localUnitPrice: "10.01",
    remoteUnitPrice: "10.01",
  });
  const invoice = (
    id: string,
    providerInvoiceId: string,
    quantity: string,
  ) => ({
    id,
    jobId: "job",
    customerId: "customer",
    providerCustomerId: "4001",
    providerInvoiceId,
    currency: "USD",
    active: true as const,
    voided: false as const,
    linkedTransactionsComplete: true as const,
    linkedDocuments: [],
    lines: [line("line-" + id, quantity)],
    proof: proof(providerInvoiceId),
  });
  return {
    company: { ...company },
    customerId: "customer",
    providerCustomerId: "4001",
    jobId: "job",
    productId: "product",
    itemId: "1001",
    stockUnit: "sqft",
    scope: {
      ...snapshot(),
      allIssueSourcesIncluded: true,
      allJobReturnsIncluded: true,
      allPriorClaimsIncluded: true,
      invoiceRefundLookupsComplete: true,
    },
    quantity: {
      worksTotalIncludingTransit: "3",
      quickBooksOnHand: "0",
      itemActive: true,
      itemType: "Inventory",
      trackQtyOnHand: true,
      proof: proof("1001"),
    },
    receipts,
    billLines,
    bindings,
    issues: [
      movement("issue1", "6", [slice("r1", "movement1", "6")]),
      movement("issue2", "4", [slice("r2", "movement2", "4")]),
    ],
    returns: [
      {
        ...movement("return1", "2", [slice("r1", "movement1", "2")]),
        issueId: "issue1",
        kind: "return",
      },
      {
        ...movement("return2", "1", [slice("r2", "movement2", "1")]),
        issueId: "issue2",
        kind: "return",
      },
    ],
    selectedReturnIds: ["return1", "return2"],
    invoices: [
      invoice("invoice1", "5001", "6"),
      invoice("invoice2", "5002", "4"),
    ],
    priorClaims: [],
  };
}
function manual(input: StockReturnPlanInput, reason: StockReturnPlanReason) {
  const result = planStockReturns(input);
  expect(result.kind).toBe("manual_review");
  if (result.kind === "manual_review")
    expect(result.reasonCodes).toContain(reason);
  expect(result.providerSubmissionAllowed).toBe(false);
  expect(result.financialActionsAllowed).toBe(false);
  expect(result.revaluesInventory).toBe(false);
}
function confirmed(
  input: StockReturnPlanInput,
  returnId = "return1",
  quantity = "1",
  id = "claim1",
) {
  return {
    id,
    origin: "legacy_auto" as const,
    state: "confirmed" as const,
    jobId: "job",
    productId: "product",
    realmId: company.realmId,
    environment: company.environment,
    returns: [{ returnId, quantity }],
    neverSubmitted: false,
    adjustment: {
      id: "6001",
      quantity,
      sourceReferenceVerified: true as const,
      verifiedClaimId: id,
      verifiedReturnIds: [returnId],
      proof: proof("6001"),
    },
    snapshot: snapshot(),
  };
}
describe("pure exact multi-return quantity planning", () => {
  it("supports multiple POs, receipts, partial supplier bills and customer invoices without a financial payload", () => {
    const input = fixture(),
      before = structuredClone(input),
      result = planStockReturns(input);
    expect(result.kind).toBe("ready_quantity_plan");
    expect(input).toEqual(before);
    if (result.kind === "ready_quantity_plan") {
      expect(result.quantityDifference).toBe("3.000000");
      expect(result.sourceRefs.orderIds).toEqual(["po1", "po2"]);
      expect(result.sourceRefs.providerBillIds).toEqual(["2001", "2002"]);
      expect(result.invoiceIds).toEqual(["invoice1", "invoice2"]);
      expect(result.returnQuantities).toEqual([
        { returnId: "return1", quantity: "2.000000" },
        { returnId: "return2", quantity: "1.000000" },
      ]);
      expect(result).not.toHaveProperty("document");
      expect(result).not.toHaveProperty("journalEntry");
      expect(result.warnings.join(" ")).toContain("supplier credit");
    }
    expect(result.providerSubmissionAllowed).toBe(false);
  });
  it("supports a repeated partial return after an exact confirmed old adjustment without consuming it twice", () => {
    const input = fixture(),
      prior = structuredClone(input.returns[0]);
    prior.id = "earlier-return";
    prior.quantity = "1";
    prior.slices[0].quantity = "1";
    input.returns.push(prior);
    input.priorClaims = [confirmed(input, "earlier-return", "1")];
    input.quantity.worksTotalIncludingTransit = "4";
    input.quantity.quickBooksOnHand = "1";
    const result = planStockReturns(input);
    expect(result.kind).toBe("ready_quantity_plan");
    if (result.kind === "ready_quantity_plan") {
      expect(result.quantityDifference).toBe("3.000000");
      expect(result.sourceRefs.confirmedClaimIds).toEqual(["claim1"]);
      expect(result.returnIds).not.toContain("earlier-return");
    }
  });
  it("deducts exact confirmed partial claims from the same return before planning only the remaining quantity", () => {
    const input = fixture();
    input.priorClaims = [confirmed(input)];
    input.quantity.quickBooksOnHand = "1";
    const result = planStockReturns(input);
    expect(result.kind).toBe("ready_quantity_plan");
    if (result.kind === "ready_quantity_plan")
      expect(result.returnQuantities[0].quantity).toBe("1.000000");
  });
  it("retains a reviewed actual receipt/bill cost variance without changing either source rate or job costs", () => {
    const input = fixture();
    input.billLines[0].billedUnitCost = "2.25";
    manual(input, "variance_review_missing");
    input.bindings[0].varianceNote =
      "Owner verified actual supplier price difference";
    input.bindings[0].varianceClassification = "price_variance";
    const result = planStockReturns(input);
    expect(result.kind).toBe("ready_quantity_plan");
    expect(input.receipts[0].acquisitionUnitCost).toBe("2.000001");
    expect(input.billLines[0].billedUnitCost).toBe("2.25");
    if (result.kind === "ready_quantity_plan")
      expect(result.warnings[0]).toContain("does not revalue");
  });
  it("accepts only a proven immutable one-micro conversion-rounding difference without inventing a price variance", () => {
    const input = fixture();
    input.billLines[0].billedUnitCost = "2.000002";
    const binding = input.bindings[0];
    binding.varianceClassification = "unit_conversion_rounding";
    binding.roundingEvidence = {
      version: 1,
      buyQuantity: "1",
      buyUnitCost: "6.000006",
      approvedBuyUnitCost: "6.000006",
      stockUnitsPerBuyUnit: "3",
      approvedStockUnitsPerBuyUnit: "3",
      printedLineAmountCents: "600",
      stockQuantity: "3",
      receiptStockUnitCost: "2.000001",
      billedStockUnitCost: "2.000002",
    };
    const result = planStockReturns(input);
    expect(result.kind).toBe("ready_quantity_plan");
    if (result.kind === "ready_quantity_plan")
      expect(result.warnings[0]).toContain("one-micro");
    binding.roundingEvidence.approvedBuyUnitCost = "6.000007";
    manual(input, "variance_review_missing");
  });
  it("refuses source-kind aliases even when identity and quantities otherwise agree", () => {
    const input = fixture();
    input.issues[0].kind = "return";
    manual(input, "unsupported_source");
    const other = fixture();
    other.returns[0].kind = "consume";
    manual(other, "unsupported_source");
  });
  it("supports exact six-place quantities without binary floating point", () => {
    const input = fixture();
    input.returns[0].quantity = "0.000001";
    input.returns[0].slices[0].quantity = "0.000001";
    input.returns[1].quantity = "0.000002";
    input.returns[1].slices[0].quantity = "0.000002";
    input.quantity.worksTotalIncludingTransit = "0.000003";
    const result = planStockReturns(input);
    expect(result.kind).toBe("ready_quantity_plan");
    if (result.kind === "ready_quantity_plan")
      expect(result.quantityDifference).toBe("0.000003");
  });
  it.each(["pending", "submitted", "unknown"] as const)(
    "keeps old/new %s outcomes manual before another adjustment",
    (state) => {
      const input = fixture();
      const claim = confirmed(input);
      input.priorClaims = [
        { ...claim, origin: "manual_case", state, adjustment: null },
      ];
      manual(input, "prior_claim_unresolved");
    },
  );
  it("does not release a cancelled unknown submission or count an unsubmitted rejection as remote confirmation", () => {
    const input = fixture();
    input.priorClaims = [
      {
        ...confirmed(input),
        state: "cancelled_unsubmitted",
        neverSubmitted: false,
        adjustment: null,
      },
    ];
    manual(input, "prior_claim_unresolved");
    input.priorClaims[0].neverSubmitted = true;
    expect(planStockReturns(input).kind).toBe("ready_quantity_plan");
  });
  it("requires exact adjustment source references, not a coincident item/quantity", () => {
    const input = fixture();
    input.priorClaims = [confirmed(input)];
    input.quantity.quickBooksOnHand = "1";
    input.priorClaims[0].adjustment!.verifiedClaimId = "different-claim";
    manual(input, "prior_claim_unresolved");
  });
  it.each([
    "scope",
    "receipt",
    "bill",
    "binding",
    "issue",
    "return",
    "invoice",
    "claim",
  ])("rejects a stale %s snapshot", (kind) => {
    const input = fixture();
    if (kind === "scope") input.scope.currentFingerprint = "b".repeat(64);
    if (kind === "receipt")
      input.receipts[0].snapshot.currentFingerprint = "b".repeat(64);
    if (kind === "bill")
      input.billLines[0].proof.currentFingerprint = "b".repeat(64);
    if (kind === "binding")
      input.bindings[0].snapshot.currentFingerprint = "b".repeat(64);
    if (kind === "issue")
      input.issues[0].snapshot.currentFingerprint = "b".repeat(64);
    if (kind === "return")
      input.returns[0].snapshot.currentFingerprint = "b".repeat(64);
    if (kind === "invoice")
      input.invoices[0].proof.currentFingerprint = "b".repeat(64);
    if (kind === "claim") {
      input.priorClaims = [confirmed(input)];
      input.priorClaims[0].snapshot.currentFingerprint = "b".repeat(64);
    }
    manual(input, "stale_scope");
  });
  it.each(["realmId", "environment", "connectionId", "itemId", "documentId"])(
    "rejects wrong provider %s readback",
    (field) => {
      const input = fixture();
      (input.billLines[0].proof as unknown as Record<string, unknown>)[field] =
        "wrong";
      manual(input, "wrong_company_or_item");
    },
  );
  it.each([
    "allIssueSourcesIncluded",
    "allJobReturnsIncluded",
    "allPriorClaimsIncluded",
    "invoiceRefundLookupsComplete",
  ])("refuses incomplete %s evidence", (field) => {
    const input = fixture();
    (input.scope as unknown as Record<string, unknown>)[field] = false;
    manual(input, "incomplete_scope");
  });
  it.each(["opening", "catalog", "reviewed_opening"] as const)(
    "never substitutes a %s source for a purchase receipt",
    (source) => {
      const input = fixture();
      input.receipts[0].source = source;
      manual(input, "unsupported_source");
    },
  );
  it("rejects service-only invoices and actual local-versus-provider item/rate/customer changes", () => {
    for (const field of [
      "detailType",
      "remoteQuantity",
      "remoteUnitPrice",
      "customerId",
      "providerCustomerId",
    ]) {
      const input = fixture();
      if (field === "detailType")
        input.invoices[0].lines[0].detailType = "Service";
      if (field === "remoteQuantity")
        input.invoices[0].lines[0].remoteQuantity = "5";
      if (field === "remoteUnitPrice")
        input.invoices[0].lines[0].remoteUnitPrice = "10.02";
      if (field === "customerId")
        input.invoices[0].customerId = "another-customer";
      if (field === "providerCustomerId")
        input.invoices[0].providerCustomerId = "another-provider-customer";
      manual(input, "invoice_quantity_mismatch");
    }
  });
  it.each(["CreditMemo", "RefundReceipt"])(
    "keeps an actual linked %s in separate review rather than inferring stock restoration or cash",
    (type) => {
      const input = fixture();
      input.invoices[0].linkedDocuments = [
        { id: "7001", type, itemLines: [{ itemId: "1001", quantity: "1" }] },
      ];
      manual(input, "invoice_credit_or_refund");
    },
  );
  it("does not count duplicated provider invoices through separate local records", () => {
    const input = fixture();
    input.invoices[1].providerInvoiceId = input.invoices[0].providerInvoiceId;
    input.invoices[1].proof.documentId = input.invoices[0].providerInvoiceId;
    manual(input, "duplicate_identity");
  });
  it("does not count one actual bill merchandise line via duplicate queue rows", () => {
    const input = fixture();
    input.billLines[1].providerBillId = input.billLines[0].providerBillId;
    input.billLines[1].proof.documentId = input.billLines[0].providerBillId;
    manual(input, "duplicate_identity");
  });
  it("cannot count local-to-provider endorsements as a second physical receipt", () => {
    const input = fixture();
    input.bindings.push({
      ...structuredClone(input.bindings[0]),
      id: "duplicate-endorsement",
    });
    manual(input, "receipt_bill_coverage_unverified");
  });
  it("blocks receipt, base-allocation and bill-side overcoverage independently", () => {
    const input = fixture();
    input.receipts[0].allocatedQuantity = "7";
    manual(input, "receipt_bill_coverage_overallocated");
    const base = fixture();
    for (const binding of base.bindings)
      if (binding.base.id === "base1") binding.base.quantity = "5";
    manual(base, "receipt_bill_coverage_overallocated");
    const bill = fixture();
    bill.billLines[0].boundQuantity = "4";
    manual(bill, "receipt_bill_coverage_overallocated");
  });
  it("requires all receipt provider bindings and actual immutable source hashes", () => {
    const input = fixture();
    input.bindings.splice(1, 1);
    manual(input, "receipt_bill_coverage_unverified");
    const changed = fixture();
    changed.bindings[0].billSourceFingerprint = "b".repeat(64);
    manual(changed, "receipt_bill_coverage_unverified");
  });
  it("never rewrites receipt acquisition cost when issue/return traces differ", () => {
    const input = fixture();
    input.issues[0].slices[0].acquisitionUnitCost = "2.000002";
    manual(input, "source_cost_mismatch");
  });
  it("rejects a returned receipt source that differs from its original issue", () => {
    const input = fixture();
    input.returns[0].slices[0].receiptLineId = "r2";
    input.returns[0].slices[0].movementId = "movement2";
    manual(input, "return_quantity_invalid");
  });
  it("bounds all repeated return quantities by the specific original issue", () => {
    const input = fixture();
    const extra = structuredClone(input.returns[0]);
    extra.id = "extra";
    extra.quantity = "5";
    extra.slices[0].quantity = "5";
    input.returns.push(extra);
    input.selectedReturnIds.push(extra.id);
    manual(input, "return_quantity_invalid");
  });
  it("does not free a prior adjustment's quantity through a changed source or oversized claim", () => {
    const input = fixture();
    input.priorClaims = [confirmed(input, "return1", "3")];
    manual(input, "prior_claim_overallocated");
  });
  it("rejects provider adjustment duplication and mismatched retained quantity", () => {
    const input = fixture();
    input.priorClaims = [
      confirmed(input),
      { ...confirmed(input, "return2", "1", "claim2") },
    ];
    manual(input, "duplicate_identity");
    const mismatch = fixture();
    mismatch.priorClaims = [confirmed(mismatch)];
    mismatch.priorClaims[0].adjustment!.quantity = "2";
    manual(mismatch, "prior_claim_overallocated");
  });
  it("requires all unresolved returns and rejects an unexplained stock delta including transit", () => {
    const input = fixture();
    input.selectedReturnIds = ["return2"];
    manual(input, "unselected_unclaimed_return");
    const delta = fixture();
    delta.quantity.worksTotalIncludingTransit = "4";
    manual(delta, "quantity_difference_unexplained");
  });
  it("does not offer an already fully accounted return again", () => {
    const input = fixture();
    input.priorClaims = [confirmed(input, "return1", "2")];
    manual(input, "return_already_accounted");
  });
  it.each(["0.0000001", "NaN", "Infinity", "-1", "1e2"])(
    "keeps malformed/inexact %s quantities manual",
    (value) => {
      const input = fixture();
      input.returns[0].quantity = value;
      manual(input, "invalid_evidence");
    },
  );
  it("returns a safe manual disposition for missing runtime data rather than throwing", () => {
    const input = fixture();
    delete (input as unknown as Record<string, unknown>).bindings;
    manual(input, "invalid_evidence");
  });
});
