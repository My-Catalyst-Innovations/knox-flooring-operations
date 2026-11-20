import { createHash } from "node:crypto";
import { CreateProductBody } from "@workspace/api-zod";
import {
  catalogImportHeaders,
  catalogImportMaxRows,
  readCsv,
  type CatalogImportPreview,
  type CatalogImportRow,
} from "@workspace/domain";

export const catalogSkuLock = "product-catalog-sku";
export const catalogKey = (value: string) => value.trim().toLowerCase();

interface OpeningBalance {
  warehouseId: string;
  quantity: number;
}

interface ImportProduct {
  details: {
    sku: string;
    name: string;
    category: string;
    unit: string;
    supplier: string;
    cost: number;
    price: number;
    coveragePerUnit: number | null;
    coverageUnit: string | null;
  };
  balances: OpeningBalance[];
}

function decimal(value: string) {
  return /^\d{1,7}(?:\.\d{1,4})?$/.test(value) ? Number(value) : null;
}

export function planCatalogImport(
  csv: string,
  existingProducts: readonly { sku: string; id: string }[],
  warehouses: readonly { name: string; id: string }[],
): { preview: CatalogImportPreview; products: ImportProduct[] } {
  const productsBySku = new Map<string, ImportProduct>();
  const recordedSkus = new Map<string, string[]>();
  for (const product of existingProducts) {
    const key = catalogKey(product.sku);
    const existing = recordedSkus.get(key) ?? [];
    existing.push(product.id);
    recordedSkus.set(key, existing);
  }
  const warehouseIds = new Map(
    warehouses.map(({ name, id }) => [catalogKey(name), id]),
  );
  const matchedSkus = new Map<string, string>();
  const rows: CatalogImportRow[] = [];
  const errors: string[] = [];
  const result = () => {
    const products = [...productsBySku.values()];
    const newProducts = products.length;
    const previewKey = createHash("sha256")
      .update(JSON.stringify([csv, rows, errors, products, [...matchedSkus]]))
      .digest("hex");
    return { preview: { rows, errors, newProducts, previewKey }, products };
  };

  let records: ReturnType<typeof readCsv>;
  try {
    records = readCsv(csv);
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : "The CSV could not be read.",
    );
    return result();
  }
  const [header, ...data] = records;
  const headers = header?.fields.map(catalogKey) ?? [];
  const recognizedHeaders = new Set<string>(catalogImportHeaders);
  const missing = catalogImportHeaders
    .slice(0, 6)
    .filter((name) => !headers.includes(name));
  const unknown = headers.filter((name) => !recognizedHeaders.has(name));
  if (missing.length) errors.push(`Missing columns: ${missing.join(", ")}.`);
  if (unknown.length)
    errors.push(
      `Unrecognized columns: ${unknown.map((name) => name || "(blank)").join(", ")}. Use the catalog CSV template.`,
    );
  if (new Set(headers).size !== headers.length)
    errors.push("The file has repeated column names.");
  if (!data.length) errors.push("Add at least one product row.");
  if (data.length > catalogImportMaxRows)
    errors.push(`Import up to ${catalogImportMaxRows} rows at a time.`);
  if (errors.length) return result();

  const columns = new Map(headers.map((name, index) => [name, index]));
  for (const { line, fields } of data) {
    const get = (name: string) => fields[columns.get(name) ?? -1] ?? "";
    const internalSku = get("internal_sku");
    const sourceItemId = get("source_item_id");
    const sku =
      internalSku ||
      (sourceItemId.length > 0 && sourceItemId.length <= 200
        ? `SKU-${createHash("sha256").update(`catalog-source:${sourceItemId}`).digest("hex").slice(0, 16).toUpperCase()}`
        : "");
    const name = get("name");
    const unit = get("unit").toLowerCase();
    const warehouse = get("warehouse");
    const onHand = get("on_hand") ? decimal(get("on_hand")) : 0;
    const cost = decimal(get("unit_cost"));
    const price = decimal(get("sale_price"));
    const row: CatalogImportRow = {
      line,
      sku,
      name,
      warehouse,
      onHand,
      unit,
      unitCost: cost,
      salePrice: price,
      status: "new",
    };
    rows.push(row);
    const reject = (message: string) =>
      Object.assign(row, { status: "error", message });
    const key = catalogKey(sku);
    const existing = recordedSkus.get(key);
    if (fields.length !== headers.length || !sku || sku.length > 200) {
      reject(
        "Check the column count and enter an internal SKU or stable source item ID of up to 200 characters.",
      );
      continue;
    }
    if (existing && existing.length > 1) {
      reject(
        "Multiple catalog records share this internal SKU. Resolve the duplicate in Inventory.",
      );
      continue;
    }
    if (existing) {
      matchedSkus.set(key, existing[0]);
      row.status = "existing";
      row.message = "Existing product and stock will be kept as saved.";
      continue;
    }
    const coverage = get("coverage_per_unit")
      ? decimal(get("coverage_per_unit"))
      : unit === "sqft"
        ? 1
        : null;
    if (
      !name ||
      name.length > 250 ||
      get("supplier").length > 200 ||
      cost === null ||
      price === null ||
      (get("coverage_per_unit") && !(coverage && coverage > 0))
    ) {
      reject(
        "Enter a product name, numeric unit cost and sale price. Optional coverage must be positive.",
      );
      continue;
    }
    const product = CreateProductBody.safeParse({
      sku,
      name,
      category: get("category"),
      unit,
      cost,
      price,
      supplier: get("supplier"),
      coveragePerUnit: coverage,
      coverageUnit: coverage ? "sqft" : null,
    });
    if (!product.success) {
      reject("Use a category and stock unit from the Inventory product form.");
      continue;
    }
    const warehouseId = warehouseIds.get(catalogKey(warehouse));
    if (
      onHand === null ||
      (warehouse && (!warehouseId || !get("on_hand"))) ||
      (onHand > 0 && !warehouseId)
    ) {
      reject(
        "For an opening count, enter a configured warehouse name and a nonnegative quantity.",
      );
      continue;
    }
    const details = {
      sku,
      name,
      unit: product.data.unit,
      category: product.data.category,
      supplier: get("supplier"),
      cost,
      price,
      coveragePerUnit: coverage,
      coverageUnit: coverage ? "sqft" : null,
    };
    const prior = productsBySku.get(key);
    if (
      prior &&
      (JSON.stringify(prior.details) !== JSON.stringify(details) ||
        !warehouseId ||
        prior.balances.length === 0 ||
        prior.balances.some((balance) => balance.warehouseId === warehouseId))
    ) {
      reject(
        "Repeat a new SKU only for a different warehouse, with the same product details.",
      );
      continue;
    }
    const entry = prior ?? { details, balances: [] };
    if (warehouseId) entry.balances.push({ warehouseId, quantity: onHand });
    productsBySku.set(key, entry);
    if (!internalSku)
      row.message = "Internal SKU assigned from the source item ID.";
  }
  return result();
}
