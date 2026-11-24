import { billLineLimit, billLineTemplate, previewBillIntake, validateBillLine, type VendorBillLine } from "./vendor-bill-intake";

export type InvoiceWord = {
  text: string;
  left: number;
  right: number;
  centerY: number;
  height: number;
  confidence?: number;
};
export type InvoicePage = { page: number; words: InvoiceWord[]; ocr: boolean };
type Field = keyof VendorBillLine | "amount" | "description" | "lineNumber";
type Column = InvoiceWord & { field: Field };
type ExtractedLine = { line: VendorBillLine; page: number; row: number; endRow?: number; sourceAmount?: string };

const headings: Record<string, Field> = {
  "supplier sku": "supplierSku", "vendor sku": "supplierSku", sku: "supplierSku", "part number": "supplierSku",
  "part #": "supplierSku", "item number": "supplierSku", "item #": "supplierSku", "item code": "supplierSku",
  code: "supplierSku", "product code": "supplierSku", "product id": "supplierSku", "part id": "supplierSku",
  "manufacturer part number": "supplierSku", "internal sku": "supplierSku",
  unit: "unit", uom: "unit", "u/m": "unit", "purchase unit": "unit",
  qty: "quantity", quantity: "quantity",
  "unit price": "unitCost", "unit cost": "unitCost", "billed unit cost": "unitCost", "price per unit": "unitCost",
  each: "unitCost",
  amount: "amount", extension: "amount", extended: "amount", "extended price": "amount", "line total": "amount",
  total: "amount",
  description: "description", "item description": "description", "product description": "description",
  product: "description",
  line: "lineNumber", "line #": "lineNumber", "#": "lineNumber",
};
const required: (keyof VendorBillLine)[] = ["supplierSku", "unit", "quantity", "unitCost"];
const footer = /^(?:subtotal|sub total|merchandise total|sales tax|tax|freight|shipping|discount|total|invoice total|amount due|total due|balance due|grand total)\s*:?(?:\s+(?:USD\s+)?\$?[()\d.,-]+)?$/i;
const pageNumber = /^page\s+\d+(?:\s+(?:of\s+)?\d+)?$/i;
const currency = /^\$?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,6})?|\.\d{1,6})$/;

function textRows(words: InvoiceWord[]) {
  const lines: InvoiceWord[][] = [];
  for (const word of words.filter(({ text }) => text.trim()).sort((a, b) => a.centerY - b.centerY || a.left - b.left)) {
    const line = lines.at(-1);
    if (line && Math.abs(line[0].centerY - word.centerY) <= Math.max(2, Math.min(line[0].height, word.height) * 0.45))
      line.push(word);
    else lines.push([word]);
  }
  return lines.map((line) => line.sort((a, b) => a.left - b.left));
}

function headerColumns(words: InvoiceWord[]): Column[] | null {
  const columns: Column[] = [];
  for (let position = 0; position < words.length;) {
    let accepted: Column | undefined;
    let consumed = 0;
    for (let end = position; end < Math.min(words.length, position + 4); end++) {
      if (end > position && words[end].left - words[end - 1].right > Math.max(4, words[end].height * 0.85)) break;
      const phrase = words.slice(position, end + 1).map(({ text }) => text).join(" ").toLowerCase().trim().replace(/[_\s-]+/g, " ").replace(/\s+usd$/, "");
      const field = Object.hasOwn(headings, phrase) ? headings[phrase] : undefined;
      if (field) {
        accepted = { ...words[position], right: words[end].right, field };
        consumed = end - position + 1;
      }
    }
    if (!accepted) return null;
    columns.push(accepted);
    position += consumed;
  }
  const fields = new Set(columns.map(({ field }) => field));
  return fields.size === columns.length && required.every((field) => fields.has(field)) ? columns : null;
}

function groupCells(words: InvoiceWord[], columns: Column[]) {
  // Header text can be far shorter than its data (a product description or an
  // internal SKU). The next column's left edge bounds the cell, not the midpoint
  // of two header labels. Require a visible gap before crossing that next edge.
  const boundaries = columns.slice(1).map((column) => column.left);
  const cells = new Map<Field, InvoiceWord[]>();
  for (const word of words) {
    const center = (word.left + word.right) / 2;
    const columnIndex = boundaries.findIndex((boundary) => center < boundary);
    const field = columns[columnIndex < 0 ? columns.length - 1 : columnIndex].field;
    // A word crossing the ruled gap could be a merged or misread field.
    if (boundaries.some((boundary) => word.left < boundary - 2 && word.right >= boundary - 1)) return null;
    const cell = cells.get(field) ?? [];
    cell.push(word);
    cells.set(field, cell);
  }
  return cells;
}

function amountFromCell(value: string) {
  return currency.test(value) ? value.replace(/[$,]/g, "") : value;
}

function importedRow(words: InvoiceWord[], columns: Column[], page: InvoicePage, row: number): ExtractedLine | null {
  const cells = groupCells(words, columns);
  if (!cells) return null;
  const text = (field: Field) => (cells.get(field) ?? []).map((word) => word.text).join(" ").trim();
  const quantity = text("quantity");
  const line = {
    supplierSku: text("supplierSku"),
    unit: text("unit"),
    quantity: /^\d{1,3}(?:,\d{3})+(?:\.\d{1,6})?$/.test(quantity) ? quantity.replace(/,/g, "") : quantity,
    unitCost: amountFromCell(text("unitCost")),
  };
  if (Object.keys(validateBillLine(line)).length) return null;
  for (const field of [...required, "amount"] as const) {
    if (page.ocr && cells.get(field)?.some(({ confidence }) => (confidence ?? 0) < 80)) {
      throw new Error(`Page ${page.page}, row ${row} has uncertain scanned text. Check the original and enter its lines manually or use CSV.`);
    }
  }
  const sourceAmount = columns.some(({ field }) => field === "amount") ? amountFromCell(text("amount")) : undefined;
  if (sourceAmount !== undefined && !/^(?:\d{1,10}(?:\.\d{1,2})?|\.\d{1,2})$/.test(sourceAmount)) {
    throw new Error(`Page ${page.page}, row ${row} has an unreadable line amount. Use CSV or manual entry.`);
  }
  return { line, page: page.page, row, sourceAmount };
}

function extractPage(page: InvoicePage): ExtractedLine[] {
  const rows = textRows(page.words);
  const headerIndex = rows.findIndex((row) => headerColumns(row) !== null);
  if (headerIndex < 0) throw new Error(`Page ${page.page} does not have a readable table with supplier SKU, unit, quantity and unit cost. Use CSV or manual entry.`);
  const columns = headerColumns(rows[headerIndex])!;
  const result: ExtractedLine[] = [];
  let ending = false;
  let priorContentY: number | undefined;
  let continuationRows = 0;
  for (const [index, words] of rows.entries()) {
    if (index <= headerIndex) continue;
    const text = words.map((word) => word.text.trim()).join(" ");
    if (pageNumber.test(text) || footer.test(text)) {
      ending = true;
      continue;
    }
    const item = importedRow(words, columns, page, index + 1);
    if (!item && !ending && result.length && priorContentY !== undefined && continuationRows < 4) {
      const cells = groupCells(words, columns);
      const description = cells?.get("description");
      const gap = words[0].centerY - priorContentY;
      // Only a nearby line wholly within an explicit description column may
      // continue an item. Missing or uncertain financial/code cells never pass.
      if (description?.length && cells?.size === 1 && gap > 0 && gap <= Math.max(...words.map((word) => word.height)) * 2 &&
          description.some((word) => /\p{L}/u.test(word.text)) &&
          !description.some((word) => /\$|\b(?:USD|EUR|GBP)\b/i.test(word.text) || (page.ocr && (word.confidence ?? 0) < 80))) {
        result.at(-1)!.endRow = index + 1;
        priorContentY = words[0].centerY;
        continuationRows++;
        continue;
      }
    }
    if (!item || ending) throw new Error(`Page ${page.page}, row ${index + 1} does not align with the bill table. Use CSV or manual entry.`);
    result.push(item);
    priorContentY = words[0].centerY;
    continuationRows = 0;
    if (result.length > billLineLimit) throw new Error(`Import at most ${billLineLimit} item lines per bill.`);
  }
  if (!result.length) throw new Error(`Page ${page.page} has no complete bill lines. Use CSV or manual entry.`);
  return result;
}

function cents(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt((whole || "0") + fraction.padEnd(2, "0"));
}

export function previewBillDocument(pages: InvoicePage[]) {
  const lines = pages.flatMap(extractPage);
  if (!lines.length || lines.length > billLineLimit) throw new Error(`Import between 1 and ${billLineLimit} item lines per bill.`);
  const quote = (text: string) => `"${text.replace(/"/g, '""')}"`;
  const csv = billLineTemplate + lines.map(({ line }) => required.map((field) => quote(line[field])).join(",")).join("\r\n");
  const preview = previewBillIntake(csv);
  if (preview.problems.length || preview.rows.length !== lines.length) throw new Error("The document's bill lines did not pass validation. Use CSV or manual entry.");
  for (const [index, item] of lines.entries()) {
    if (item.sourceAmount !== undefined && cents(item.sourceAmount) !== preview.rows[index].amountCents) {
      throw new Error(`Page ${item.page}, row ${item.row} does not match its printed line amount. Check the original and use CSV or manual entry.`);
    }
  }
  return {
    preview,
    sources: lines.map(({ page, row, endRow }) => ({ page, row, ...(endRow === undefined ? {} : { endRow }) })),
    usedOcr: pages.some(({ ocr }) => ocr),
  };
}
