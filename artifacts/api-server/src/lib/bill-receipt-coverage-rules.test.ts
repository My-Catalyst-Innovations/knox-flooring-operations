import { expect, it } from "vitest";
import {
  coverageMicros,
  coverageDecimal,
  previewReceiptBillCoverage,
  verifyCoverageRoundingEvidence,
  type CoverageBillLine,
  type CoverageReceipt,
  type CoverageRoundingEvidence,
} from "@workspace/domain";
const receipt = (id: string, quantity = "10.000001"): CoverageReceipt => ({
  id,
  receiptId: "receipt-" + id,
  orderId: "po-" + id,
  orderNumber: "00001",
  reference: "00002",
  supplier: "Fictional Supply",
  productId: "product",
  sku: "000012",
  productName: "Fictional material",
  warehouseId: "warehouse",
  warehouseName: "Fictional",
  stockUnit: "sqft",
  quantity,
  unitCost: "4.460001",
  allocatedQuantity: "0.000000",
  remainingQuantity: quantity,
  sourceFingerprint: "a".repeat(64),
});
const bill = (
  id: string,
  index = 0,
  quantity = "10.000001",
): CoverageBillLine => ({
  key: `${id}:${index}`,
  billId: id,
  billLineIndex: index,
  billNumber: "000078",
  supplier: "Fictional Supply",
  productId: "product",
  sku: "000012",
  productName: "Fictional material",
  stockUnit: "sqft",
  quantity,
  unitCost: "4.460001",
  allocatedQuantity: "0.000000",
  remainingQuantity: quantity,
  sourceFingerprint: "b".repeat(64),
  vendorId: "1",
  itemId: "2",
  postedBillId: "3",
  verification: "verified",
  eligible: true,
  blockedReason: null,
});
const allocation = (
  receiptLineId: string,
  billId: string,
  quantity: string,
  billLineIndex = 0,
) => ({ receiptLineId, billId, billLineIndex, quantity, varianceNote: "" });
const choice = (allocations: ReturnType<typeof allocation>[]) => ({
  billIds: [...new Set(allocations.map((a) => a.billId))],
  allocations,
  note: "Owner reviewed fictional exact source records",
});
it("covers multiple receipts/POs and multiple partial bills exactly without changing received costs", () => {
  const result = previewReceiptBillCoverage(
    choice([
      allocation("r1", "b1", "3.000000"),
      allocation("r1", "b2", "7.000001"),
      allocation("r2", "b2", "2.000000"),
    ]),
    [receipt("r1"), receipt("r2", "2")],
    [bill("b1", 0, "3"), bill("b2", 0, "9.000001")],
  );
  expect(result.receiptResiduals.map((r) => r.remainingQuantity)).toEqual([
    "0.000000",
    "0.000000",
  ]);
  expect(result.billResiduals.map((b) => b.remainingQuantity)).toEqual([
    "0.000000",
    "0.000000",
  ]);
  expect(result.lines[1].receiptExtendedCost).toBe("31.220011460001");
  expect(result.lines[1].variance).toBe("0.000000000000");
});
it("keeps receipt-cost versus invoice-cost variance explicit and never rewrites acquisition cost", () => {
  const r = receipt("r"),
    b = { ...bill("b"), unitCost: "5.000000" },
    c = choice([allocation("r", "b", "2")]);
  expect(() => previewReceiptBillCoverage(c, [r], [b])).toThrow(
    /variance note/,
  );
  c.allocations[0].varianceNote =
    "Owner verified a separately billed price change";
  const result = previewReceiptBillCoverage(c, [r], [b]);
  expect(result.lines[0].receipt.unitCost).toBe("4.460001");
  expect(result.lines[0].variance).toBe("1.079998000000");
  expect(result.warnings[0]).toContain("does not revalue");
});
it.each(["receipt", "bill"])(
  "refuses cumulative %s overcoverage across distinct review allocations",
  (side) => {
    const r = receipt("r", "10"),
      b = bill("b", 0, "10");
    if (side === "receipt") r.allocatedQuantity = "8.000000";
    else b.allocatedQuantity = "8.000000";
    expect(() =>
      previewReceiptBillCoverage(choice([allocation("r", "b", "3")]), [r], [b]),
    ).toThrow(/exceeds/);
  },
);
it("does not merge duplicate pairs or use price equality as product/unit/supplier evidence", () => {
  expect(() =>
    previewReceiptBillCoverage(
      choice([allocation("r", "b", "1"), allocation("r", "b", "1")]),
      [receipt("r")],
      [bill("b")],
    ),
  ).toThrow(/duplicate/);
  for (const change of [
    { productId: "other" },
    { stockUnit: "box" },
    { supplier: "Other Supplier" },
  ])
    expect(() =>
      previewReceiptBillCoverage(
        choice([allocation("r", "b", "1")]),
        [receipt("r")],
        [{ ...bill("b"), ...change }],
      ),
    ).toThrow(/must match/);
});
it("treats duplicate same-SKU bill lines as separate index identities", () => {
  const result = previewReceiptBillCoverage(
    choice([allocation("r", "b", "2", 0), allocation("r", "b", "3", 1)]),
    [receipt("r")],
    [bill("b", 0, "2"), bill("b", 1, "3")],
  );
  expect(result.billResiduals).toEqual([
    { key: "b:0", remainingQuantity: "0.000000" },
    { key: "b:1", remainingQuantity: "0.000000" },
  ]);
});
it("retains local-only disposition and blocks ineligible or missing source records", () => {
  const result = previewReceiptBillCoverage(
    choice([allocation("r", "b", "1")]),
    [receipt("r")],
    [
      {
        ...bill("b"),
        verification: "local_only",
        vendorId: null,
        itemId: null,
        postedBillId: null,
      },
    ],
  );
  expect(result.warnings[0]).toContain("does not upgrade");
  expect(() =>
    previewReceiptBillCoverage(
      choice([allocation("r", "b", "1")]),
      [receipt("r")],
      [{ ...bill("b"), eligible: false }],
    ),
  ).toThrow(/eligible/);
});
it.each(["-1", "NaN", "Infinity", "0.0000001", "1e2", "01.0"])(
  "rejects noncanonical or inexact decimal %s",
  (value) => expect(() => coverageMicros(value)).toThrow(),
);
it("performs quantity arithmetic with exact large decimals, never binary floating point", () => {
  expect(coverageDecimal(coverageMicros("999999999999.999999"))).toBe(
    "999999999999.999999",
  );
  expect(
    coverageDecimal(coverageMicros("0.000001") + coverageMicros("0.000002")),
  ).toBe("0.000003");
});
const roundingProof: CoverageRoundingEvidence = {
  version: 1,
  buyQuantity: "1",
  buyUnitCost: "64.15",
  approvedBuyUnitCost: "64.15",
  stockUnitsPerBuyUnit: "19.52",
  approvedStockUnitsPerBuyUnit: "19.52",
  printedLineAmountCents: "6415",
  stockQuantity: "19.52",
  receiptStockUnitCost: "3.286372",
  billedStockUnitCost: "3.286373",
};
it("classifies only documented 64.15/19.52 conversion rounding and retains exact partial residuals", () => {
  expect(
    verifyCoverageRoundingEvidence(
      roundingProof,
      "3.286372",
      "3.286373",
      "19.52",
    ),
  ).toBe(true);
  const r = { ...receipt("r", "19.52"), unitCost: "3.286372" },
    b = {
      ...bill("b", 0, "19.52"),
      unitCost: "3.286373",
      roundingSource: roundingProof,
    };
  const one = previewReceiptBillCoverage(
    choice([allocation("r", "b", "7")]),
    [r],
    [b],
  );
  const two = previewReceiptBillCoverage(
    choice([allocation("r", "b", "12.52")]),
    [{ ...r, allocatedQuantity: "7" }],
    [{ ...b, allocatedQuantity: "7" }],
  );
  expect(one.lines[0].varianceClassification).toBe("unit_conversion_rounding");
  expect(one.lines[0].displayVarianceCents).toBe("0");
  expect(one.lines[0].roundingEvidence).toEqual(roundingProof);
  expect(one.lines[0].variance).toBe("0.000007000000");
  expect(two.lines[0].variance).toBe("0.000012520000");
  expect(two.receiptResiduals[0].remainingQuantity).toBe("0.000000");
  expect(two.billResiduals[0].remainingQuantity).toBe("0.000000");
});
it.each([
  { approvedBuyUnitCost: "64.16" },
  { approvedStockUnitsPerBuyUnit: "19.53" },
  { printedLineAmountCents: "6416" },
  { stockQuantity: "19.53" },
  { receiptStockUnitCost: "3.286370" },
  { billedStockUnitCost: "3.286372" },
])("rejects changed or unproven rounding source %j", (change) => {
  const proof = { ...roundingProof, ...change };
  expect(
    verifyCoverageRoundingEvidence(
      proof,
      proof.receiptStockUnitCost,
      proof.billedStockUnitCost,
      proof.stockQuantity,
    ),
  ).toBe(false);
});
it("does not waive a material price difference merely because its small partial allocation rounds to zero cents", () => {
  const r = { ...receipt("r", "19.52"), unitCost: "3.280000" },
    b = {
      ...bill("b", 0, "19.52"),
      unitCost: "3.286373",
      roundingSource: roundingProof,
    };
  expect(() =>
    previewReceiptBillCoverage(
      choice([allocation("r", "b", "0.000001")]),
      [r],
      [b],
    ),
  ).toThrow(/variance note/);
});
