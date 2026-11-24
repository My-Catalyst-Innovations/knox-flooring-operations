import { describe, expect, it } from "vitest";
import {
  openPoDecimal,
  openPoImportColumns,
  openPoMicros,
  openPoSnapshotTimes,
  parseOpenPoCsv,
  validateOpenPoChoices,
  type OpenPoDecision,
} from "@workspace/domain";
const header = openPoImportColumns.join(",");
const values = [
  "00001",
  "000078",
  "000001",
  "Partially received",
  "Supplier source001",
  "Office warehouse",
  "",
  "000012",
  "sq ft",
  "12.300001",
  "2.1",
  "0.2",
  "10.000001",
  "4.460001",
  "USD",
  "2026-12-01",
];
const csv = (rows = [values]) =>
  header + "\r\n" + rows.map((row) => row.join(",")).join("\r\n");
const choice = (): OpenPoDecision => ({
  sourcePoId: "00001",
  action: "create",
  note: "Owner verified open source order",
  supplierId: "supplier",
  supplierRevision: 1,
  warehouseId: "warehouse",
  jobId: null,
  sourceOpenConfirmed: true,
  outstandingOnlyConfirmed: true,
  lines: [
    {
      line: 2,
      action: "include",
      productId: "product",
      productRevision: 1,
      note: "Reviewed source stock unit",
    },
  ],
});
describe("outstanding-only PO import rules", () => {
  it("retains original textual identifiers, status and source decimals without manufacturing receipts", () => {
    const [order] = parseOpenPoCsv("\uFEFF" + csv());
    expect(order.errors).toEqual([]);
    expect(order.lines[0]).toMatchObject({
      sourcePoId: "00001",
      sourcePoNumber: "000078",
      sourceLineId: "000001",
      productRef: "000012",
      orderedQty: "12.300001",
      receivedQty: "2.1",
      cancelledQty: "0.2",
      outstandingQty: "10.000001",
      unitCost: "4.460001",
      sourceStatus: "Partially received",
    });
    expect(
      validateOpenPoChoices(order, choice())[0].source.outstandingQty,
    ).toBe("10.000001");
  });
  it("uses exact bounded decimal arithmetic, including six-decimal low quantities and high costs", () => {
    expect(openPoMicros("0.1") + openPoMicros("0.2")).toBe(openPoMicros("0.3"));
    expect(openPoDecimal(openPoMicros("999999999999.999999"))).toBe(
      "999999999999.999999",
    );
    for (const value of [
      "",
      "1e3",
      "-1",
      "NaN",
      "Infinity",
      "0.0000001",
      "1000000000000",
      "+1",
      "1,000",
    ])
      expect(() => openPoMicros(value)).toThrow();
  });
  it("blocks an inexact source quantity reconciliation and missing source cost", () => {
    const mismatch = [...values];
    mismatch[12] = "10.000002";
    expect(parseOpenPoCsv(csv([mismatch]))[0].errors.join(" ")).toMatch(
      /equal outstanding exactly/,
    );
    const missing = [...values];
    missing[13] = "";
    expect(parseOpenPoCsv(csv([missing]))[0].errors.length).toBeGreaterThan(0);
    expect(() =>
      validateOpenPoChoices(parseOpenPoCsv(csv([missing]))[0], choice()),
    ).toThrow(/Correct or explicitly skip/);
  });
  it("requires explicit zero-cost evidence and leaves zero outstanding lines for explicit skip", () => {
    const zero = [...values];
    zero[13] = "0";
    const order = parseOpenPoCsv(csv([zero]))[0];
    expect(() => validateOpenPoChoices(order, choice())).toThrow(
      /genuine zero source cost/,
    );
    const reviewed = choice();
    reviewed.lines![0].zeroCostReason =
      "Supplier confirmed replacement at zero cost";
    expect(validateOpenPoChoices(order, reviewed)).toHaveLength(1);
    const closed = [...values];
    closed[2] = "000002";
    closed[9] = "1";
    closed[10] = "1";
    closed[11] = "0";
    closed[12] = "0";
    const both = parseOpenPoCsv(csv([values, closed]))[0],
      decision = choice();
    decision.lines!.push({
      line: 3,
      action: "skip",
      note: "Already fully received before cutover",
    });
    expect(validateOpenPoChoices(both, decision)).toHaveLength(1);
    decision.lines![1] = {
      line: 3,
      action: "include",
      productId: "other",
      productRevision: 1,
      note: "",
    };
    expect(() => validateOpenPoChoices(both, decision)).toThrow(
      /no outstanding quantity/,
    );
  });
  it("blocks mixed headers, duplicate source lines, unsupported currencies and invalid dates", () => {
    const mixed = [...values];
    mixed[4] = "Other supplier";
    mixed[2] = "000002";
    expect(parseOpenPoCsv(csv([values, mixed]))[0].errors.join(" ")).toMatch(
      /inconsistent header/,
    );
    expect(parseOpenPoCsv(csv([values, values]))[0].errors.join(" ")).toMatch(
      /line IDs must be unique/,
    );
    const invalid = [...values];
    invalid[14] = "EUR";
    invalid[15] = "0000-01-01";
    expect(parseOpenPoCsv(csv([invalid]))[0].errors.join(" ")).toMatch(/USD/);
    expect(parseOpenPoCsv(csv([invalid]))[0].errors.join(" ")).toMatch(
      /real expected/,
    );
  });
  it("refuses unsupported headers, invalid UTF8 representation and byte or row overflow", () => {
    expect(() =>
      parseOpenPoCsv(csv().replace("unit_cost", "balance_due")),
    ).toThrow(/template/);
    expect(() => parseOpenPoCsv(csv() + "\ud800")).toThrow(/valid UTF-8/);
    expect(() => parseOpenPoCsv("é".repeat(100001))).toThrow(/200 KB/);
    expect(() =>
      parseOpenPoCsv(csv(Array.from({ length: 201 }, () => values))),
    ).toThrow(/200 source lines/);
  });
  it("requires every row and explicit identity/open/outstanding choices with no product consolidation", () => {
    const [order] = parseOpenPoCsv(csv());
    const missing = choice();
    missing.sourceOpenConfirmed = false;
    expect(() => validateOpenPoChoices(order, missing)).toThrow(
      /source is still open/,
    );
    const duplicate = [...values];
    duplicate[2] = "000002";
    const two = parseOpenPoCsv(csv([values, duplicate]))[0];
    expect(() => validateOpenPoChoices(two, choice())).toThrow(
      /every source line/,
    );
    const sameProduct = choice();
    sameProduct.lines!.push({ ...sameProduct.lines![0], line: 3 });
    expect(() => validateOpenPoChoices(two, sameProduct)).toThrow(
      /duplicate products/,
    );
    const link = choice();
    link.action = "link";
    expect(() => validateOpenPoChoices(order, link)).toThrow(
      /existing open purchase order/,
    );
  });
  it("requires explicit real calendar timestamps with snapshot no later than cutover and neither in the future", () => {
    const now = Date.parse("2026-11-24T02:00:00Z");
    expect(
      openPoSnapshotTimes(
        "2026-11-23T15:00:00-05:00",
        "2026-11-23T16:00:00-05:00",
        now,
      ),
    ).toBe(true);
    for (const value of [
      "2026-02-31T10:00:00Z",
      "2026-11-23T24:00:00Z",
      "2026-11-23T10:00:00",
      "0000-01-01T00:00:00Z",
    ])
      expect(openPoSnapshotTimes(value, "2026-11-24T01:00:00Z", now)).toBe(
        false,
      );
    expect(
      openPoSnapshotTimes("2026-11-24T02:00:00Z", "2026-11-24T01:00:00Z", now),
    ).toBe(false);
    expect(
      openPoSnapshotTimes("2026-11-24T01:00:00Z", "2099-01-01T00:00:00Z", now),
    ).toBe(false);
  });
});
