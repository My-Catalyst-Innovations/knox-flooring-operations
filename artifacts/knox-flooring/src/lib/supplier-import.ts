import { readCsv } from "@workspace/domain";

export interface SupplierImportProduct {
  id: string;
  sku: string;
  supplier: string;
  unit: string;
  cost: number;
  name: string;
  active: boolean;
}

export interface SupplierCrosswalkAlias {
  id: string;
  productId: string;
  supplier: string;
  supplierSku: string;
  manufacturerPartNumber: string | null;
  latestPrice: {
    unit: string;
    unitCost: string;
    effectiveOn: string;
    source: string;
  } | null;
}

export interface SupplierImportRow {
  line: number;
  supplier: string;
  supplierSku: string;
  internalSku: string;
  manufacturerPartNumber: string;
  unit: string;
  unitCost: string;
  product?: SupplierImportProduct;
  latestPrice?: NonNullable<SupplierCrosswalkAlias["latestPrice"]>;
  canChooseProduct?: boolean;
  chosenSku?: string;
  status:
    | "matched"
    | "unmatched"
    | "ambiguous"
    | "archived"
    | "unit-mismatch"
    | "duplicate"
    | "invalid";
  message: string;
  priceDifference?: "same" | "higher" | "lower";
}

export interface SupplierImportPreview {
  rows: SupplierImportRow[];
  errors: string[];
}

const requiredHeaders = ["supplier", "supplier_sku", "unit", "unit_cost"];
const normalize = (value: string) => value.trim().toLowerCase();
const supplierSkuKey = (supplier: string, sku: string) =>
  JSON.stringify([normalize(supplier), normalize(sku)]);

function addProduct(
  index: Map<string, SupplierImportProduct[]>,
  key: string,
  product: SupplierImportProduct,
) {
  const matches = index.get(key);
  if (matches) matches.push(product);
  else index.set(key, [product]);
}

export function previewSupplierImport(
  csv: string,
  products: readonly SupplierImportProduct[],
  aliases: readonly SupplierCrosswalkAlias[] = [],
  chosenSkus?: ReadonlyMap<number, string>,
): SupplierImportPreview {
  let records: ReturnType<typeof readCsv>;
  try {
    records = readCsv(csv);
  } catch (error) {
    return {
      rows: [],
      errors: [
        error instanceof Error ? error.message : "The CSV could not be read.",
      ],
    };
  }

  const [header, ...data] = records;
  const headers = header?.fields.map(normalize) ?? [];
  const missing = requiredHeaders.filter((name) => !headers.includes(name));
  const errors: string[] = [];
  if (missing.length)
    errors.push(`Missing CSV columns: ${missing.join(", ")}.`);
  const repeated = headers.filter(
    (name, index) => headers.indexOf(name) < index,
  );
  if (repeated.length) {
    errors.push(`Repeated CSV columns: ${[...new Set(repeated)].join(", ")}.`);
  }
  if (!errors.length && !data.length)
    errors.push("Add at least one supplier price row.");
  if (errors.length) return { rows: [], errors };

  const indexes = new Map(headers.map((name, index) => [name, index]));
  const inputRows = data.map(({ line, fields }) => {
    const get = (name: string) => fields[indexes.get(name) ?? -1] ?? "";
    return {
      line,
      supplier: get("supplier"),
      supplierSku: get("supplier_sku"),
      internalSku: get("internal_sku"),
      manufacturerPartNumber: get("manufacturer_part_number"),
      unit: get("unit"),
      unitCost: get("unit_cost"),
    };
  });

  const occurrences = new Map<string, number>();
  for (const row of inputRows) {
    const key = supplierSkuKey(row.supplier, row.supplierSku);
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }

  const bySku = new Map<string, SupplierImportProduct[]>();
  const bySupplierSku = new Map<string, SupplierImportProduct[]>();
  const byId = new Map(products.map((product) => [product.id, product]));
  const byAlias = new Map(
    aliases.map((alias) => [
      supplierSkuKey(alias.supplier, alias.supplierSku),
      alias,
    ]),
  );
  for (const product of products) {
    const sku = normalize(product.sku);
    if (!sku) continue;
    addProduct(bySku, sku, product);
    addProduct(bySupplierSku, supplierSkuKey(product.supplier, sku), product);
  }

  const rows = inputRows.map((row, index): SupplierImportRow => {
    if (data[index].fields.length !== headers.length) {
      return {
        ...row,
        status: "invalid",
        message: "Column count differs from the header.",
      };
    }
    if (!row.supplier || !row.supplierSku || !row.unit || !row.unitCost) {
      return {
        ...row,
        status: "invalid",
        message: "Supplier, supplier SKU, unit, and unit cost are required.",
      };
    }
    const proposedCost = Number(row.unitCost);
    if (!/^(?:\d{1,12}(?:\.\d{1,6})?|\.\d{1,6})$/.test(row.unitCost)) {
      return {
        ...row,
        status: "invalid",
        message:
          "Enter a nonnegative decimal unit cost with up to six decimal places, without a currency symbol.",
      };
    }

    const key = supplierSkuKey(row.supplier, row.supplierSku);
    if ((occurrences.get(key) ?? 0) > 1) {
      return {
        ...row,
        status: "duplicate",
        message: "This supplier and SKU appear more than once in the file.",
      };
    }
    const alias = byAlias.get(key);
    const approvedProduct = alias ? byId.get(alias.productId) : undefined;
    if (alias && !approvedProduct) {
      return {
        ...row,
        status: "unmatched",
        message: "The approved product is unavailable in the catalog.",
      };
    }
    const supplierMatches = approvedProduct
      ? [approvedProduct]
      : (bySupplierSku.get(key) ?? []);
    const chosenSku = chosenSkus?.get(row.line);
    const canChooseProduct = !alias && !supplierMatches.length;
    const internalSku = chosenSku ?? row.internalSku;
    const matches = internalSku
      ? (bySku.get(normalize(internalSku)) ?? [])
      : supplierMatches;
    if (matches.length > 1) {
      return {
        ...row,
        chosenSku,
        status: "ambiguous",
        message: "Multiple catalog products match this SKU.",
      };
    }
    const [product] = matches;
    if (!product) {
      return {
        ...row,
        chosenSku,
        canChooseProduct,
        status: "unmatched",
        message: internalSku
          ? "No catalog product matches the supplied internal SKU."
          : "Choose the product for this supplier SKU.",
      };
    }
    if (
      internalSku &&
      supplierMatches.some((match) => match.id !== product.id)
    ) {
      return {
        ...row,
        chosenSku,
        status: "ambiguous",
        message:
          "The internal SKU and supplier SKU point to different catalog products.",
      };
    }
    if (
      alias?.manufacturerPartNumber &&
      row.manufacturerPartNumber &&
      normalize(alias.manufacturerPartNumber) !==
        normalize(row.manufacturerPartNumber)
    ) {
      return {
        ...row,
        product,
        chosenSku,
        status: "ambiguous",
        message:
          "The manufacturer part number conflicts with the approved crosswalk.",
      };
    }
    if (!product.active) {
      return {
        ...row,
        product,
        chosenSku,
        status: "archived",
        message: "The matched product is archived.",
      };
    }
    if (!product.sku.trim()) {
      return {
        ...row,
        product,
        chosenSku,
        status: "invalid",
        message:
          "Assign an internal SKU in the catalog before approving a supplier crosswalk.",
      };
    }
    if (normalize(product.unit) !== normalize(row.unit)) {
      return {
        ...row,
        product,
        chosenSku,
        status: "unit-mismatch",
        message: `The catalog uses ${product.unit}; confirm the supplier unit before comparing costs.`,
      };
    }
    const latestPrice =
      alias?.latestPrice &&
      normalize(alias.latestPrice.unit) === normalize(row.unit)
        ? alias.latestPrice
        : undefined;
    const proposed = latestPrice ? scaledPrice(row.unitCost) : proposedCost;
    const reference = latestPrice
      ? scaledPrice(latestPrice.unitCost)
      : product.cost;
    return {
      ...row,
      product,
      chosenSku,
      canChooseProduct: !!chosenSku && canChooseProduct,
      status: "matched",
      latestPrice,
      message: alias
        ? "Matched by approved crosswalk."
        : chosenSku
          ? "Matched by your catalog selection."
          : row.internalSku
            ? "Matched by internal SKU."
            : "Matched by supplier and SKU.",
      priceDifference:
        proposed === reference
          ? "same"
          : proposed > reference
            ? "higher"
            : "lower",
    };
  });

  return { rows, errors };
}

function scaledPrice(price: string): bigint {
  const [whole, fraction = ""] = price.split(".");
  return BigInt((whole || "0") + fraction.padEnd(6, "0"));
}
