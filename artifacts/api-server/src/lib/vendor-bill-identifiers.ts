import { DomainError } from "./operations-rules";
import type { VendorBillProductCodeType } from "./vendor-bill";

type CatalogRow = {
  alias: { supplierSkuKey: string; manufacturerPartNumber: string | null };
  product: { sku: string };
};

export function supplierBillProductCode(row: CatalogRow, kind: VendorBillProductCodeType) {
  const value = kind === "manufacturer_part_number" ? row.alias.manufacturerPartNumber
    : kind === "internal_sku" ? row.product.sku : row.alias.supplierSkuKey;
  return value?.trim().toLowerCase() ?? "";
}

/** The caller supplies only this supplier's approved aliases. Identifier kinds
 * are explicit: never guess a product from price or a different namespace. */
export function uniqueSupplierBillMatch<Row extends CatalogRow>(
  catalog: readonly Row[],
  code: string,
  kind: VendorBillProductCodeType,
): Row | undefined {
  const normalized = code.trim().toLowerCase();
  const candidates = catalog.filter(row => supplierBillProductCode(row, kind) === normalized);
  if (candidates.length > 1) {
    throw new DomainError(409,
      `The product code ${code} matches more than one supplier mapping. Review the mappings or use the unique supplier SKU before approving this bill.`);
  }
  return candidates[0];
}
