import { describe, expect, it } from "vitest";
import {
  parseSupplierImportCsv,
  supplierImportMaxBytes,
} from "@workspace/domain";

describe("bounded supplier contact source contract", () => {
  it("preserves text IDs, phone zeros, exact source labels and inert formula-shaped notes", () => {
    const { rows } = parseSupplierImportCsv(
      "\uFEFFsource_id,name,phone,postal_code,notes\r\n000081,Original Supply,000001,00123,=1+1\r\n",
    );
    expect(rows[0]).toMatchObject({
      data: {
        sourceId: "000081",
        name: "Original Supply",
        phone: "000001",
        postalCode: "00123",
        notes: "=1+1",
      },
      errors: [],
    });
  });
  it("keeps quoted multiline and tab exports as source text", () => {
    expect(
      parseSupplierImportCsv(
        'source_id\tname\tnotes\r\n001\tSupply\t"First\r\nSecond"',
        "\t",
      ).rows[0].data.notes,
    ).toBe("First\nSecond");
  });
  it("separates duplicate source identities from duplicate names for explicit owner review", () => {
    const { rows } = parseSupplierImportCsv(
      "source_id,name\n001,Supply\n002,SUPPLY\n001,Other",
    );
    expect(rows.map((row) => row.fileDuplicates)).toEqual([[4], [], [2]]);
    expect(rows.map((row) => row.nameDuplicates)).toEqual([[3], [2], []]);
  });
  it.each([
    "source_id,name,balance\n1,Supply,100",
    "source_id,name,name\n1,Supply,Other",
    "name\nSupply",
  ])("rejects financial, duplicate or missing identity columns", (csv) =>
    expect(() => parseSupplierImportCsv(csv)).toThrow(/template/),
  );
  it("reports invalid emails, missing names, controls and inconsistent rows without sending anything", () => {
    const { rows } = parseSupplierImportCsv(
      "source_id,name,email\n1,,bad email\n2,Supply\n3,Bad\u0001Name,",
    );
    expect(rows[0].errors.join(" ")).toMatch(/name/);
    expect(rows[0].errors.join(" ")).toMatch(/email/);
    expect(rows[1].errors.join(" ")).toMatch(/field count/);
    expect(rows[2].errors.join(" ")).toMatch(/name/);
  });
  it("bounds actual UTF8 bytes, rows, quotes and Unicode validity", () => {
    expect(() =>
      parseSupplierImportCsv(
        "source_id,name\n1," + "é".repeat(supplierImportMaxBytes / 2),
      ),
    ).toThrow(/1 MiB/);
    expect(() =>
      parseSupplierImportCsv(
        "source_id,name\n" +
          Array.from({ length: 201 }, (_, i) => `${i},Supply ${i}`).join("\n"),
      ),
    ).toThrow(/200/);
    expect(() => parseSupplierImportCsv("source_id,name\n1,\ud800")).toThrow(
      /UTF-8/,
    );
    expect(() => parseSupplierImportCsv('source_id,name\n1,"Open')).toThrow(
      /Unclosed/,
    );
  });
});
