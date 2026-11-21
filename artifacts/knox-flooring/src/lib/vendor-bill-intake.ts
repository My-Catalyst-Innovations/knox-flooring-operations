import { readCsv } from "@workspace/domain";

export type VendorBillLine = {
  supplierSku: string;
  unit: string;
  quantity: string;
  unitCost: string;
};

export const billIntakeLimit = 128_000;
export const billLineLimit = 50;
export const billLineTemplate = "supplier_sku,unit,quantity,unit_cost\r\n";

export const billLineFields = [
  ["supplierSku", "Supplier SKU"], ["unit", "Unit"],
  ["quantity", "Quantity"], ["unitCost", "Billed unit cost"],
] as const;

const matchingHeaders = {
  supplierSku: ["supplier_sku", "vendor_sku"],
  unit: ["unit"],
  quantity: ["quantity"],
  unitCost: ["unit_cost", "billed_unit_cost"],
} satisfies Record<keyof VendorBillLine, string[]>;

const decimal = /^(?:\d{1,6}(?:\.\d{1,6})?|\.\d{1,6})$/;
const billTotal = /^(?:\d{1,10}(?:\.\d{1,2})?|\.\d{1,2})$/;

export function validBillTotal(value: string) {
  return billTotal.test(value) && Number(value) > 0;
}

export function validateBillLine(line: VendorBillLine) {
  const issues: Partial<Record<keyof VendorBillLine, string>> = {};
  if (!line.supplierSku.trim() || line.supplierSku.trim().length > 200 || /[\r\n\0]/.test(line.supplierSku))
    issues.supplierSku = "Enter the supplier SKU as printed, up to 200 characters on one line.";
  if (!line.unit.trim() || line.unit.trim().length > 200 || /[\r\n\0]/.test(line.unit))
    issues.unit = "Enter the purchase unit as printed, up to 200 characters on one line.";
  if (!decimal.test(line.quantity) || Number(line.quantity) <= 0)
    issues.quantity = "Enter a positive quantity with up to six decimal places and no separators.";
  if (!decimal.test(line.unitCost))
    issues.unitCost = "Enter a nonnegative decimal price with up to six decimal places and no currency symbol or separators.";
  return issues;
}

type IntakeRow = { rowNumber: number; line: VendorBillLine; amountCents: bigint };
type Intake = { rows: IntakeRow[]; totalCents: bigint; problems: string[] };

function scaledSix(text: string) {
  const [whole, fractional = ""] = text.split(".");
  return BigInt((whole || "0") + fractional.padEnd(6, "0"));
}

export function billIntakeDollars(cents: bigint) {
  return `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function previewBillIntake(source: string): Intake {
  const empty = (message: string): Intake => ({ rows: [], totalCents: 0n, problems: [message] });
  if (!source.trim()) return empty("Paste or choose a file containing bill lines.");
  if (source.length > billIntakeLimit) return empty("Choose a bill-line file under 128 KB.");
  if (/^\s*%PDF-/.test(source)) return empty("Copy the line table from the PDF as comma- or tab-separated text, or export a CSV.");
  if (source.includes("\uFFFD") || source.includes("\0")) return empty("Export the bill-line table as UTF-8 text so the supplier codes stay readable.");

  const firstLine = source.split(/\r\n?|\n/).find((line) => line.trim()) ?? "";
  let records: ReturnType<typeof readCsv>;
  try {
    records = readCsv(source, firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",");
  } catch (error) {
    return empty(error instanceof Error ? error.message : "The bill-line table could not be read.");
  }

  const [header, ...body] = records;
  if (!header) return empty("Include a header row and at least one bill line.");
  const names = header.fields.map((field) => field.toLowerCase().replace(/[ -]+/g, "_"));
  const columns = billLineFields.map(([field, label]) => ({
    field, label, matches: names.flatMap((name, index) => matchingHeaders[field].includes(name) ? [index] : []),
  }));
  const headerProblems = columns.flatMap(({ label, matches }) => matches.length === 1 ? [] : [
    `Line ${header.line}, ${label}: ${matches.length ? "Keep one column for this field." : "Add the required column."}`,
  ]);
  if (names.length > billLineFields.length)
    headerProblems.push(`Line ${header.line}: Include only the four bill-line columns shown in the template.`);
  if (headerProblems.length) return { rows: [], totalCents: 0n, problems: headerProblems };
  if (!body.length || body.length > billLineLimit) return empty(`Enter between 1 and ${billLineLimit} bill lines.`);

  const problems: string[] = [];
  const rows: IntakeRow[] = [];
  for (const { line: rowNumber, fields } of body) {
    if (fields.length !== columns.length) {
      problems.push(`Line ${rowNumber}: Expected ${columns.length} columns, found ${fields.length}.`);
      continue;
    }
    const billLine = Object.fromEntries(columns.map(({ field, matches }) => [field, fields[matches[0]]])) as VendorBillLine;
    const issues = validateBillLine(billLine);
    for (const { field, label } of columns) {
      if (issues[field]) problems.push(`Line ${rowNumber}, ${label}: ${issues[field]}`);
    }
    if (Object.keys(issues).length) continue;
    const amountCents = (scaledSix(billLine.quantity) * scaledSix(billLine.unitCost) + 5_000_000_000n) / 10_000_000_000n;
    rows.push({ rowNumber, line: billLine, amountCents });
  }
  return { rows, totalCents: rows.reduce((sum, row) => sum + row.amountCents, 0n), problems };
}
