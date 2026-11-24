import { describe, expect, it } from "vitest";
import { supplierBillProductCode, uniqueSupplierBillMatch } from "./vendor-bill-identifiers";
import { vendorBillInput } from "./vendor-bill";

const serena = {
  alias: { supplierSkuKey: "000001", manufacturerPartNumber: "080081" },
  product: { sku: "MOCK-KFC-0001" },
};
const coventry = {
  alias: { supplierSkuKey: "000006", manufacturerPartNumber: "MPB782" },
  product: { sku: "MOCK-KFC-0006" },
};

describe("supplier bill product-code interpretation", () => {
  it("maps each explicitly selected code namespace to the same approved product", () => {
    expect(uniqueSupplierBillMatch([serena, coventry], "000001", "supplier_sku")).toBe(serena);
    expect(uniqueSupplierBillMatch([serena, coventry], "080081", "manufacturer_part_number")).toBe(serena);
    expect(uniqueSupplierBillMatch([serena, coventry], "MOCK-KFC-0001", "internal_sku")).toBe(serena);
  });

  it("preserves leading zeros and only normalizes case and outer whitespace", () => {
    expect(uniqueSupplierBillMatch([serena], "80081", "manufacturer_part_number")).toBeUndefined();
    expect(uniqueSupplierBillMatch([serena], "00001", "supplier_sku")).toBeUndefined();
    expect(uniqueSupplierBillMatch([coventry], " mpb782 ", "manufacturer_part_number")).toBe(coventry);
    expect(supplierBillProductCode(serena, "manufacturer_part_number")).toBe("080081");
  });

  it("does not guess across namespaces when a manufacturer's part is another product's supplier SKU", () => {
    const collision = {
      alias: { supplierSkuKey: "080081", manufacturerPartNumber: "DIFFERENT" },
      product: { sku: "MOCK-OTHER" },
    };
    expect(uniqueSupplierBillMatch([serena, collision], "080081", "manufacturer_part_number")).toBe(serena);
    expect(uniqueSupplierBillMatch([serena, collision], "080081", "supplier_sku")).toBe(collision);
    expect(uniqueSupplierBillMatch([serena], "080081", "supplier_sku")).toBeUndefined();
  });

  it.each(["manufacturer_part_number", "internal_sku"] as const)(
    "refuses multiple supplier aliases for the selected %s instead of choosing from price or position", kind => {
      const anotherAlias = { ...serena, alias: { ...serena.alias, supplierSkuKey: "ANOTHER-PACK" } };
      const code = kind === "internal_sku" ? serena.product.sku : "080081";
      expect(() => uniqueSupplierBillMatch([serena, anotherAlias], code, kind)).toThrow(/more than one supplier mapping/);
      expect(() => uniqueSupplierBillMatch([anotherAlias, serena], code, kind)).toThrow(/more than one supplier mapping/);
    },
  );

  it("does not treat absent manufacturer numbers as matching codes", () => {
    const missing = { ...serena, alias: { ...serena.alias, manufacturerPartNumber: null } };
    expect(uniqueSupplierBillMatch([missing], "080081", "manufacturer_part_number")).toBeUndefined();
  });

  it("keeps the legacy parsed request unchanged and requires a supported explicit interpretation", () => {
    const body = { mode: "review", supplier: "Mock Flooring Supply", billNumber: "MOCK-101",
      billDate: "2026-11-23", billTotal: "2.90",
      lines: [{ supplierSku: "080081", unit: "sqft", quantity: "2", unitCost: "1.45" }] };
    expect(vendorBillInput.parse(body)).not.toHaveProperty("productCodeType");
    expect(vendorBillInput.parse({ ...body, productCodeType: "manufacturer_part_number" }))
      .toMatchObject({ productCodeType: "manufacturer_part_number", lines: [{ supplierSku: "080081" }] });
    expect(vendorBillInput.safeParse({ ...body, productCodeType: "guess" }).success).toBe(false);
  });
});
