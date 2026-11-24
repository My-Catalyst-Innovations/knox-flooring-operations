import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDocument, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import { previewBillDocument, type InvoicePage } from "./vendor-bill-document";

describe("native Word invoice PDF extraction", () => {
  it("reads all15 manufacturer codes and exact printed cents with wrapped product text", async () => {
    // Internally authored fictional invoice, with public product identifiers and
    // mock quantities/prices. This exercises actual PDF text geometry, not mocks.
    const bytes = await readFile(path.resolve("src/lib/fixtures/mock-supplier-manufacturer-invoice.pdf"));
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, useWasm: false, isEvalSupported: false });
    try {
      const document = await task.promise;
      const pages: InvoicePage[] = [];
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const words = content.items.flatMap((item) => {
          if (!("str" in item) || !item.str.trim()) return [];
          const [a, b, _c, _d, left, baseline] = Util.transform(viewport.transform, item.transform);
          if (Math.abs(b) > Math.abs(a) * 0.1 || a <= 0 || !item.width) return [];
          const height = Math.max(1, item.height);
          return [{ text: item.str.trim(), left, right: left + item.width, centerY: baseline - height / 2, height }];
        });
        pages.push({ page: number, words, ocr: false });
      }
      const result = previewBillDocument(pages);
      expect(result.preview.rows.map(({ line }) => line.supplierSku)).toEqual([
        "080081", "080470", "100390", "100110", "130530", "MPB782", "28641", "APX151",
        "5E779-00544", "5E777-00110", "5663V-07099", "5E778-00129", "9550-764", "9478-534", "9222-745",
      ]);
      expect(result.preview.totalCents).toBe(43_010n);
      expect(result.preview.problems).toEqual([]);
      expect(result.sources).toHaveLength(15);
      expect(result.sources.some((source) => source.endRow !== undefined)).toBe(true);
      expect(result.usedOcr).toBe(false);
    } finally { await task.destroy(); }
  });
});
