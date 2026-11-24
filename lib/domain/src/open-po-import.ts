import { readCsv } from "./csv";

export const openPoImportMaxBytes = 200_000;
export const openPoImportMaxRows = 200;
export const openPoImportColumns = [
  "source_po_id",
  "source_po_number",
  "source_line_id",
  "source_status",
  "supplier_ref",
  "warehouse_ref",
  "job_ref",
  "product_ref",
  "unit",
  "ordered_qty",
  "received_qty",
  "cancelled_qty",
  "outstanding_qty",
  "unit_cost",
  "currency",
  "expected_on",
] as const;
export interface OpenPoSourceLine {
  line: number;
  sourcePoId: string;
  sourcePoNumber: string;
  sourceLineId: string;
  sourceStatus: string;
  supplierRef: string;
  warehouseRef: string;
  jobRef: string;
  productRef: string;
  unit: string;
  orderedQty: string;
  receivedQty: string;
  cancelledQty: string;
  outstandingQty: string;
  unitCost: string;
  currency: string;
  expectedOn: string;
}
export interface OpenPoSourceOrder {
  sourcePoId: string;
  lines: OpenPoSourceLine[];
  errors: string[];
}
export interface OpenPoLineDecision {
  line: number;
  action: "include" | "skip";
  productId?: string;
  productRevision?: number;
  note: string;
  zeroCostReason?: string;
}
export interface OpenPoDecision {
  sourcePoId: string;
  action: "create" | "link" | "skip";
  note: string;
  supplierId?: string;
  supplierRevision?: number;
  warehouseId?: string;
  warehouseUpdatedAt?: string;
  jobRevision?: number;
  jobUpdatedAt?: string;
  jobId?: string | null;
  orderId?: string;
  orderRevision?: number;
  orderFingerprint?: string;
  sourceOpenConfirmed?: boolean;
  outstandingOnlyConfirmed?: boolean;
  lines?: OpenPoLineDecision[];
}
export interface OpenPoSupplier {
  id: string;
  revision: number;
  name: string;
  active: boolean;
}
export interface OpenPoWarehouse {
  id: string;
  name: string;
  updatedAt: string;
}
export interface OpenPoProduct {
  id: string;
  revision: number;
  name: string;
  sku: string;
  unit: string;
  active: boolean;
  inventoryType: string;
  updatedAt: string;
}
export interface OpenPoJob {
  id: string;
  revision: number;
  jobNumber: string;
  customerName: string;
  status: string;
  updatedAt: string;
}
export interface OpenPoExistingOrder {
  id: string;
  revision: number;
  orderNumber: string;
  supplier: string;
  warehouseId: string;
  jobId: string | null;
  status: string;
  expectedOn: string | null;
  updatedAt: string;
  fingerprint: string;
  receiptFingerprint: string;
  lines: Array<{
    id: string;
    productId: string;
    productName: string;
    sku: string;
    unit: string;
    unitCost: string;
    quantity: string;
    receivedQty: string;
    outstandingQty: string;
  }>;
}
export interface OpenPoImportOptions {
  suppliers: OpenPoSupplier[];
  warehouses: OpenPoWarehouse[];
  products: OpenPoProduct[];
  jobs: OpenPoJob[];
  orders: OpenPoExistingOrder[];
}
export interface OpenPoPreviewOrder extends OpenPoSourceOrder {
  imported: { id: string; orderId: string } | null;
}
export interface OpenPoReviewedOrder {
  decision: OpenPoDecision;
  selected: null | {
    supplier: OpenPoSupplier;
    warehouse: OpenPoWarehouse;
    job: OpenPoJob | null;
    existingOrder: OpenPoExistingOrder | null;
    lines: Array<{
      source: OpenPoSourceLine;
      choice: OpenPoLineDecision;
      product: OpenPoProduct;
    }>;
  };
}
export interface OpenPoImportBatch {
  id: string;
  sourceSystem: string;
  batchKey: string;
  fileName: string;
  sourceSha256: string;
  sourceSnapshotAt: string;
  cutoverAt: string;
  rows: OpenPoPreviewOrder[];
  status: "preview" | "reviewed" | "approved" | "committed";
  revision: number;
  previewFingerprint: string;
  reviewFingerprint: string | null;
  reviewed: OpenPoReviewedOrder[];
  reviewNote: string | null;
  approval: {
    id: string;
    fingerprint: string;
    approvedBy: string;
    approvedAt: string;
  } | null;
  result: {
    created: number;
    linked: number;
    skipped: number;
    orders: Array<{
      sourcePoId: string;
      sourcePoNumber: string;
      orderId: string;
      orderNumber: string;
      action: "create" | "link";
    }>;
  } | null;
}
/** Never use binary floats for imported quantities, source reconciliation or costs. */
export function openPoMicros(
  value: string,
  maximum = 999_999_999_999_999_999n,
) {
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(value))
    throw new Error(
      "Use a nonnegative plain decimal with at most six decimal places.",
    );
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (result > maximum)
    throw new Error("The amount exceeds this import’s supported range.");
  return result;
}
export function openPoDecimal(value: bigint) {
  if (value < 0n) throw new Error("Negative amounts are not supported.");
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`;
}
export function openPoCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000"))
    return false;
  const parsed = Date.parse(value + "T00:00:00Z");
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  );
}
export function openPoSnapshotTimes(
  snapshot: string,
  cutover: string,
  now = Date.now(),
) {
  const valid = (value: string) => {
    const parts =
      /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
        value,
      );
    return (
      !!parts &&
      openPoCalendarDate(value.slice(0, 10)) &&
      Number(parts[1]) <= 23 &&
      Number(parts[2]) <= 59 &&
      Number(parts[3]) <= 59 &&
      Number.isFinite(Date.parse(value))
    );
  };
  return (
    valid(snapshot) &&
    valid(cutover) &&
    Date.parse(snapshot) <= Date.parse(cutover) &&
    Date.parse(cutover) <= now
  );
}
function utf8Bytes(value: string) {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      throw new Error("Use valid UTF-8 text without unpaired surrogates.");
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
}
export function parseOpenPoCsv(csv: string, delimiter: "," | "\t" = ",") {
  if (!csv || utf8Bytes(csv) > openPoImportMaxBytes || csv.includes("\0"))
    throw new Error(
      "Choose a UTF-8 CSV or TSV up to 200 KB without null bytes.",
    );
  const [head, ...records] = readCsv(csv, delimiter),
    headers = head?.fields ?? [];
  if (
    headers.length !== openPoImportColumns.length ||
    new Set(headers).size !== headers.length ||
    openPoImportColumns.some((column) => !headers.includes(column))
  )
    throw new Error(
      "Use the exact version 1 outstanding purchase-order template. Unsupported or duplicate columns are refused.",
    );
  if (!records.length || records.length > openPoImportMaxRows)
    throw new Error("Import 1–200 source lines per batch.");
  const groups = new Map<string, OpenPoSourceOrder>();
  for (const record of records) {
    const value = (key: (typeof openPoImportColumns)[number]) =>
      record.fields[headers.indexOf(key)] ?? "";
    const row: OpenPoSourceLine = {
      line: record.line,
      sourcePoId: value("source_po_id"),
      sourcePoNumber: value("source_po_number"),
      sourceLineId: value("source_line_id"),
      sourceStatus: value("source_status"),
      supplierRef: value("supplier_ref"),
      warehouseRef: value("warehouse_ref"),
      jobRef: value("job_ref"),
      productRef: value("product_ref"),
      unit: value("unit"),
      orderedQty: value("ordered_qty"),
      receivedQty: value("received_qty"),
      cancelledQty: value("cancelled_qty"),
      outstandingQty: value("outstanding_qty"),
      unitCost: value("unit_cost"),
      currency: value("currency"),
      expectedOn: value("expected_on"),
    };
    if (
      !row.sourcePoId ||
      row.sourcePoId.length > 200 ||
      /[\p{Cc}]/u.test(row.sourcePoId)
    )
      throw new Error(
        `Line ${row.line}: every order needs a plain-text source PO ID up to 200 characters before it can be reviewed.`,
      );
    const group = groups.get(row.sourcePoId) ?? {
      sourcePoId: row.sourcePoId,
      lines: [],
      errors: [],
    };
    const fail = (message: string) =>
      group.errors.push(`Line ${row.line}: ${message}`);
    if (record.fields.length !== headers.length)
      fail("The field count does not match the header.");
    for (const [key, text] of Object.entries(row))
      if (
        typeof text === "string" &&
        (/[\p{Cc}]/u.test(text) || text.length > 200)
      )
        fail(`Correct ${key}; use plain text up to 200 characters.`);
    for (const key of [
      "sourcePoId",
      "sourcePoNumber",
      "sourceLineId",
      "sourceStatus",
      "supplierRef",
      "warehouseRef",
      "productRef",
      "unit",
    ] as const)
      if (!row[key]) fail(`${key} is required.`);
    if (row.currency !== "USD")
      fail(
        "Only explicitly declared USD orders are supported; no currency is inferred or converted.",
      );
    if (row.expectedOn && !openPoCalendarDate(row.expectedOn))
      fail("Use a real expected YYYY-MM-DD date or leave it unknown.");
    try {
      const quantities = [
        row.orderedQty,
        row.receivedQty,
        row.cancelledQty,
        row.outstandingQty,
      ].map((value) => openPoMicros(value, 1_000_000_000_000n));
      if (
        quantities[0] === 0n ||
        quantities[0] - quantities[1] - quantities[2] !== quantities[3]
      )
        fail(
          "Ordered minus received minus cancelled must equal outstanding exactly; ordered must be positive.",
        );
      openPoMicros(row.unitCost);
    } catch (error) {
      fail(
        error instanceof Error
          ? error.message
          : "Correct the quantities and source unit cost.",
      );
    }
    const prior = group.lines[0];
    if (
      prior &&
      (
        [
          "sourcePoNumber",
          "sourceStatus",
          "supplierRef",
          "warehouseRef",
          "jobRef",
          "currency",
          "expectedOn",
        ] as const
      ).some((key) => prior[key] !== row[key])
    )
      fail(
        "This source order has inconsistent header values; preserve it and correct the source before review.",
      );
    if (group.lines.some((line) => line.sourceLineId === row.sourceLineId))
      fail("Source line IDs must be unique within an order.");
    group.lines.push(row);
    groups.set(row.sourcePoId, group);
  }
  for (const group of groups.values())
    if (group.lines.length > 100)
      group.errors.push("Use at most 100 source lines per purchase order.");
  return [...groups.values()];
}
export function validateOpenPoChoices(
  order: OpenPoSourceOrder,
  decision: OpenPoDecision,
) {
  if (decision.sourcePoId !== order.sourcePoId)
    throw new Error("Review the exact source purchase order.");
  if (decision.action === "skip") {
    if (decision.note.trim().length < 5)
      throw new Error("Explain why this source order is skipped.");
    return [] as Array<{
      source: OpenPoSourceLine;
      decision: OpenPoLineDecision;
    }>;
  }
  if (order.errors.length)
    throw new Error(
      "Correct or explicitly skip the entire source order before approval.",
    );
  if (!decision.sourceOpenConfirmed || !decision.outstandingOnlyConfirmed)
    throw new Error(
      "Confirm the source is still open and only remaining quantities will be carried forward.",
    );
  if (
    !decision.supplierId ||
    !decision.supplierRevision ||
    !decision.warehouseId ||
    decision.jobId === undefined
  )
    throw new Error(
      "Explicitly select the supplier, warehouse and optional job for this order.",
    );
  const choices = decision.lines ?? [];
  if (
    choices.length !== order.lines.length ||
    new Set(choices.map((item) => item.line)).size !== order.lines.length ||
    choices.some(
      (item) => !order.lines.some((source) => source.line === item.line),
    )
  )
    throw new Error("Review every source line exactly once.");
  const included: Array<{
    source: OpenPoSourceLine;
    decision: OpenPoLineDecision;
  }> = [];
  for (const source of order.lines) {
    const choice = choices.find((item) => item.line === source.line)!;
    if (choice.action === "skip") {
      if (choice.note.trim().length < 5)
        throw new Error(`Explain why source line ${source.line} is skipped.`);
      continue;
    }
    if (!choice.productId || !choice.productRevision)
      throw new Error(
        `Select an existing product for source line ${source.line}.`,
      );
    if (openPoMicros(source.outstandingQty) === 0n)
      throw new Error(
        `Source line ${source.line} has no outstanding quantity; explicitly skip it.`,
      );
    if (
      openPoMicros(source.unitCost) === 0n &&
      (choice.zeroCostReason?.trim().length ?? 0) < 10
    )
      throw new Error(
        `Explain and confirm the genuine zero source cost for line ${source.line}.`,
      );
    included.push({ source, decision: choice });
  }
  if (!included.length)
    throw new Error(
      "Include at least one positive outstanding source line or skip the order.",
    );
  if (
    new Set(included.map((item) => item.decision.productId)).size !==
    included.length
  )
    throw new Error(
      "A Works purchase order supports each product once; duplicate products cannot be combined or averaged during import.",
    );
  if (
    decision.action === "link" &&
    (!decision.orderId || !decision.orderRevision)
  )
    throw new Error(
      "Select the exact existing open purchase order and its revision.",
    );
  return included;
}
