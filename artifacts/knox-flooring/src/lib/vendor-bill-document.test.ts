import { describe, expect, it } from "vitest";
import { previewBillDocument, type InvoicePage, type InvoiceWord } from "./vendor-bill-document";

function word(text: string, left: number, centerY: number, confidence = 99): InvoiceWord {
  return { text, left, right: left + text.length * 5, centerY, height: 10, confidence };
}

function page(overrides: Partial<InvoicePage> = {}): InvoicePage {
  return {
    page: 1,
    ocr: false,
    words: [
      word("Invoice 21", 12, 18),
      word("Supplier", 12, 50), word("SKU", 56, 51), word("Unit", 140, 50), word("Qty", 225, 50),
      word("Unit Price", 305, 50), word("Line Total", 420, 50),
      word("00073", 12, 70), word("Box", 140, 70), word("10.000", 225, 70), word("$49.9250", 305, 70), word("$499.25", 420, 70),
      word("Total", 305, 90), word("$499.25", 420, 90),
    ],
    ...overrides,
  };
}

describe("supplier invoice document extraction", () => {
  it("uses positioned columns, preserves leading-zero SKUs and reconciles printed item extensions", () => {
    const result = previewBillDocument([page()]);
    expect(result.sources).toEqual([{ page: 1, row: 3 }]);
    expect(result.usedOcr).toBe(false);
    expect(result.preview.rows[0].line).toEqual({ supplierSku: "00073", unit: "Box", quantity: "10.000", unitCost: "49.9250" });
    expect(result.preview.totalCents).toBe(49_925n);
  });

  it("applies the same validation to high-confidence OCR and flags the scanned source", () => {
    const result = previewBillDocument([page({ ocr: true })]);
    expect(result.usedOcr).toBe(true);
    expect(result.preview.rows[0].line.supplierSku).toBe("00073");
  });

  it("rejects low-confidence digits, wrong source extensions, and unrecognized or incomplete pages", () => {
    const source = page().words;
    expect(() => previewBillDocument([page({ ocr: true, words: source.map((item) => item.text === "00073" ? { ...item, confidence: 63 } : item) })])).toThrow("uncertain scanned text");
    expect(() => previewBillDocument([page({ words: source.map((item) => item.text === "$499.25" && item.centerY === 70 ? { ...item, text: "$499.20" } : item) })])).toThrow("printed line amount");
    expect(() => previewBillDocument([page(), page({ page: 2, words: [word("Unreadable", 10, 50)] })])).toThrow(/Page 2.*readable table/);
  });

  it("rejects merged fields and partial rows even below a displayed total", () => {
    const source = page().words;
    const ambiguous = source.map((item) => item.text === "Box" ? { ...item, right: 225 } : item);
    expect(() => previewBillDocument([page({ words: ambiguous })])).toThrow("does not align");
    expect(() => previewBillDocument([page({ words: [...source, word("Part after total", 12, 100)] })])).toThrow("does not align");
    expect(() => previewBillDocument([page({ words: source.filter((item) => item.text !== "Box") })])).toThrow("does not align");
  });

  const wrappedPage = (extra: InvoiceWord[] = [], overrides: Partial<InvoicePage> = {}): InvoicePage => ({
    page: 1, ocr: false,
    words: [
      word("Code", 12, 50), word("Product", 98, 50), word("Qty", 330, 50), word("Unit", 390, 50), word("Each USD", 450, 50), word("Total USD", 550, 50),
      word("MOCK-KFC-0001", 12, 70), word("Philadelphia Commercial Indwell Aged Barrel", 98, 70), word("2", 330, 70), word("Box", 390, 70), word("49.925", 450, 70), word("99.85", 550, 70),
      ...extra,
      word("Total USD 99.85", 450, 160),
    ], ...overrides,
  });

  it("accepts common code/product/each/currency headers and long values within their actual column", () => {
    const result = previewBillDocument([wrappedPage([word("Oak", 98, 84)])]);
    expect(result.preview.rows).toHaveLength(1);
    expect(result.preview.rows[0].line.supplierSku).toBe("MOCK-KFC-0001");
    expect(result.preview.totalCents).toBe(9985n);
    expect(result.sources).toEqual([{ page: 1, row: 2, endRow: 3 }]);
  });

  it.each([
    ["missing-code item", [word("Next product", 98, 84), word("2", 330, 84), word("Box", 390, 84), word("10", 450, 84)]],
    ["financial annotation", [word("USD 10", 98, 84)]],
    ["numeric-only continuation", [word("00073", 98, 84)]],
    ["outside description", [word("Missing item", 12, 84)]],
    ["distant description", [word("Oak", 98, 120)]],
    ["fifth continuation", [84, 98, 112, 126, 140].map((y) => word("Oak", 98, y))],
  ])("refuses %s rather than dropping a potentially billable row", (_name, extra) => {
    expect(() => previewBillDocument([wrappedPage(extra)])).toThrow("does not align");
  });

  it("refuses uncertain scanned continuations, unknown currency headers and item text after totals", () => {
    expect(() => previewBillDocument([wrappedPage([word("Oak", 98, 84, 60)], { ocr: true })])).toThrow("does not align");
    const source = wrappedPage().words;
    expect(() => previewBillDocument([wrappedPage([], { words: source.map((item) => item.text === "Each USD" ? { ...item, text: "Each EUR" } : item) })])).toThrow("readable table");
    expect(() => previewBillDocument([wrappedPage([], { words: [...source, word("Oak", 98, 174)] })])).toThrow("does not align");
  });
});
