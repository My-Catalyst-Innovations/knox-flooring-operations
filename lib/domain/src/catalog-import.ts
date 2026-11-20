export const catalogImportHeaders = [
  "internal_sku",
  "name",
  "category",
  "unit",
  "unit_cost",
  "sale_price",
  "supplier",
  "warehouse",
  "on_hand",
  "coverage_per_unit",
  "source_item_id",
] as const;

export const catalogImportMaxBytes = 200_000;
export const catalogImportMaxRows = 1_000;

export interface CatalogImportRow {
  line: number;
  sku: string;
  name: string;
  warehouse: string;
  onHand: number | null;
  unit: string;
  unitCost: number | null;
  salePrice: number | null;
  status: "new" | "existing" | "error";
  message?: string;
}

export interface CatalogImportPreview {
  rows: CatalogImportRow[];
  errors: string[];
  newProducts: number;
  previewKey: string;
}
