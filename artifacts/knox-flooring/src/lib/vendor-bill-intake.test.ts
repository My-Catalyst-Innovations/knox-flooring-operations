import { describe, expect, it } from "vitest";
import { billIntakeDollars, billLineTemplate, previewBillIntake } from "./vendor-bill-intake";

describe("supplier bill line import", () => {
  it("keeps exact SKU, unit, and decimal strings while rounding each line in cents", () => {
    const csv = `\uFEFF${billLineTemplate}"00073",Box,10.000000,49.9250\r\n"A,007",piece,1,.005\r\n"00073",Box,1,0.005`;
    const result = previewBillIntake(csv);
    expect(result.problems).toEqual([]);
    expect(result.rows.map(({ rowNumber, line, amountCents }) => [rowNumber, line.supplierSku, line.unit, line.quantity, line.unitCost, amountCents])).toEqual([
      [2, "00073", "Box", "10.000000", "49.9250", 49925n],
      [3, "A,007", "piece", "1", ".005", 1n],
      [4, "00073", "Box", "1", "0.005", 1n],
    ]);
    expect(billIntakeDollars(result.totalCents)).toBe("$499.27");
  });

  it("recognizes reordered, explicitly labeled tab-separated columns copied from a table", () => {
    const result = previewBillIntake("Billed unit cost\tUnit\tVendor SKU\tQuantity\n12.5000\tsqft\t0000120\t.25");
    expect(result.problems).toEqual([]);
    expect(result.rows[0].line).toEqual({ supplierSku: "0000120", unit: "sqft", quantity: ".25", unitCost: "12.5000" });
    expect(result.totalCents).toBe(313n);
  });

  it("returns line and field errors and rejects ambiguous columns and unstructured text", () => {
    const invalid = previewBillIntake(`${billLineTemplate}00073,box,0,$49.00\n00074,box,2\n,box,1,10`);
    expect(invalid.problems).toEqual([
      expect.stringMatching(/^Line 2, Quantity:/), expect.stringMatching(/^Line 2, Billed unit cost:/),
      expect.stringMatching(/^Line 3: Expected 4 columns/), expect.stringMatching(/^Line 4, Supplier SKU:/),
    ]);
    expect(previewBillIntake("supplier_sku,vendor_sku,unit,quantity,unit_cost\n001,002,box,1,2").problems[0]).toMatch(/Keep one column/);
    expect(previewBillIntake("Invoice 123\nOak Floor 001 11 boxes USD 55.00").problems[0]).toMatch(/required column/);
    expect(previewBillIntake("%PDF-1.7\nfoo").problems[0]).toMatch(/Copy the line table/);
    expect(previewBillIntake(`${billLineTemplate}"unclosed`).problems[0]).toMatch(/Unclosed quoted field/);
    expect(previewBillIntake(`${billLineTemplate}${"00073,box,1,10\n".repeat(51)}`).problems[0]).toMatch(/1 and 50/);
  });
});
