import { describe, expect, it } from "vitest";
import {
  previewSupplierImport,
  type SupplierImportProduct,
} from "./supplier-import";

const headers = "supplier,supplier_sku,unit,unit_cost";
const product: SupplierImportProduct = {
  id: "product-1",
  sku: "00042",
  supplier: 'Good, "Better" Flooring',
  unit: "sqft",
  cost: 1.875,
  name: "Sample oak",
  active: true,
};
const supplier = '"Good, ""Better"" Flooring"';

describe("supplier CSV preview", () => {
  it("reads a BOM, CRLF, quoted commas and escapes without losing SKU or price precision", () => {
    const csv = `\uFEFF${headers},manufacturer_part_number\r\n${supplier},"00042",SQFT,1.8750,"000,9"\r\n`;

    expect(previewSupplierImport(csv, [product])).toMatchObject({
      errors: [],
      rows: [
        {
          line: 2,
          supplier: product.supplier,
          supplierSku: "00042",
          manufacturerPartNumber: "000,9",
          unitCost: "1.8750",
          product: { id: product.id },
          status: "matched",
          priceDifference: "same",
        },
      ],
    });
  });

  it("matches an explicit internal SKU and reports both directions of price change", () => {
    const csv = `${headers},internal_sku\nFactory One,Oak-013,sqft,1.876,00042\nFactory Two,013,sqft,.99,00042`;
    const preview = previewSupplierImport(csv, [product]);

    expect(preview.errors).toEqual([]);
    expect(preview.rows).toMatchObject([
      {
        status: "matched",
        priceDifference: "higher",
        product: { id: product.id },
      },
      {
        status: "matched",
        priceDifference: "lower",
        product: { id: product.id },
      },
    ]);
    expect(previewSupplierImport(csv, [product])).toEqual(preview);
  });

  it("never guesses a product from another supplier, punctuation, or manufacturer number", () => {
    const csv = `${headers},manufacturer_part_number\nAnother supplier,00042,sqft,1,00042\n${supplier},000-42,sqft,1,00042`;

    expect(
      previewSupplierImport(csv, [product]).rows.map((row) => row.status),
    ).toEqual(["unmatched", "unmatched"]);
  });

  it("flags explicit SKUs that are unknown or contradict an existing supplier match", () => {
    const csv = `${headers},internal_sku\n${supplier},00042,sqft,1,other\nFactory,00042,sqft,1,missing`;
    const other = { ...product, id: "product-2", sku: "OTHER" };

    expect(
      previewSupplierImport(csv, [product, other]).rows.map(
        (row) => row.status,
      ),
    ).toEqual(["ambiguous", "unmatched"]);
  });

  it("revalidates a manually selected SKU against supplier mappings, manufacturer codes, duplicates, and units", () => {
    const csv = `${headers},manufacturer_part_number\nFactory,PICKED,sqft,1.50,PART-A\nFactory,OLD,sqft,1,PART-B\nFactory,PART,sqft,1,OTHER-PART\nFactory,DUP,sqft,1,\nFACTORY,dup,sqft,1,\nFactory,UNIT,box,1,`;
    const alias = {
      id: "alias-1",
      productId: product.id,
      supplier: "Factory",
      supplierSku: "OLD",
      manufacturerPartNumber: "PART-B",
      latestPrice: null,
    };
    const other = { ...product, id: "other-1", sku: "OTHER" };
    const selected = new Map([
      [2, product.sku],
      [3, other.sku],
      [4, product.sku],
      [5, product.sku],
      [6, product.sku],
      [7, product.sku],
    ]);
    const { rows } = previewSupplierImport(
      csv,
      [product, other],
      [alias, { ...alias, supplierSku: "PART" }],
      selected,
    );
    expect(rows).toMatchObject([
      {
        status: "matched",
        canChooseProduct: true,
        chosenSku: product.sku,
        product: { id: product.id },
      },
      {
        status: "ambiguous",
        message: expect.stringContaining("point to different catalog products"),
      },
      {
        status: "ambiguous",
        message: expect.stringContaining("manufacturer part number conflicts"),
      },
      { status: "duplicate" },
      { status: "duplicate" },
      { status: "unit-mismatch" },
    ]);
  });

  it("resolves approved aliases and compares against the latest negotiated cost precisely", () => {
    const csv = `${headers},manufacturer_part_number\nFactory,AB-12,sqft,999999999999.000001,M-35\nFactory,AB-13,sqft,1,M-36`;
    const saved = {
      id: "alias-1",
      productId: product.id,
      supplier: "factory",
      supplierSku: "ab-12",
      manufacturerPartNumber: "M-35",
      latestPrice: {
        unit: "sqft",
        unitCost: "999999999999.000000",
        effectiveOn: "2026-11-20",
        source: "Agreement A",
      },
    };
    const { rows } = previewSupplierImport(
      csv,
      [product],
      [saved, { ...saved, id: "alias-2", supplierSku: "AB-13" }],
    );
    expect(rows).toMatchObject([
      {
        status: "matched",
        priceDifference: "higher",
        latestPrice: { source: "Agreement A" },
      },
      {
        status: "ambiguous",
        message: expect.stringContaining("manufacturer part number"),
      },
    ]);
  });

  it("flags ambiguous catalog matches, archived products, and incompatible units", () => {
    const csv = `${headers},internal_sku\nFactory,A-X,sqft,2,SHARED\nFactory,B-X,sqft,2,ARCHIVED\nFactory,C-X,box,48,00042`;
    const catalog = [
      product,
      { ...product, id: "shared-1", sku: "SHARED" },
      { ...product, id: "shared-2", sku: "shared" },
      { ...product, id: "old", sku: "ARCHIVED", active: false },
    ];

    const { rows } = previewSupplierImport(csv, catalog);
    expect(rows).toMatchObject([
      { status: "ambiguous" },
      { status: "archived", product: { id: "old" } },
      { status: "unit-mismatch", product: { id: product.id } },
    ]);
    expect(rows.map((row) => row.priceDifference)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("flags every repeated supplier SKU without confusing the same code at different suppliers", () => {
    const csv = `${headers},internal_sku\nFactory A,M-20,sqft,2,00042\nfactory a,m-20,sqft,2.50,00042\nFactory B,M-20,sqft,0,00042`;

    expect(previewSupplierImport(csv, [product]).rows).toMatchObject([
      { status: "duplicate" },
      { status: "duplicate" },
      { status: "matched", priceDifference: "lower" },
    ]);
  });

  it("reports individual problems with pricing, required cells, and column counts", () => {
    const csv = `${headers}\nFactory,D,sqft,-2\nFactory,E,sqft,3e2\nFactory,F, ,1\nFactory,G,sqft,1,extra`;

    expect(previewSupplierImport(csv, [product]).rows).toMatchObject([
      {
        status: "invalid",
        line: 2,
        message: expect.stringContaining("decimal"),
      },
      {
        status: "invalid",
        line: 3,
        message: expect.stringContaining("decimal"),
      },
      {
        status: "invalid",
        line: 4,
        message: expect.stringContaining("required"),
      },
      {
        status: "invalid",
        line: 5,
        message: expect.stringContaining("Column count"),
      },
    ]);
  });

  it("keeps physical line numbers correct after quoted multiline cells", () => {
    const csv = `${headers},description\n${supplier},00042,sqft,1.875,"Oak\nFlooring"\nFactory,H,sqft,invalid,Description`;

    expect(previewSupplierImport(csv, [product]).rows).toMatchObject([
      { status: "matched", line: 2 },
      { status: "invalid", line: 4 },
    ]);
  });

  it("reports malformed quotes and missing, repeated, or empty header data", () => {
    expect(
      previewSupplierImport(`${headers}\n"Broken`, []).errors[0],
    ).toContain("line 2");
    expect(
      previewSupplierImport("supplier,supplier_sku", []).errors[0],
    ).toContain("unit, unit_cost");
    expect(
      previewSupplierImport(`${headers},Supplier`, []).errors[0],
    ).toContain("Repeated CSV columns: supplier");
    expect(previewSupplierImport(headers, []).errors[0]).toContain(
      "at least one supplier price row",
    );
  });
});
