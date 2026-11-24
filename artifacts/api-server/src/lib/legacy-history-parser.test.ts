import { describe, expect, it } from "vitest";
import {
  legacyArchiveMaxBytes,
  parseLegacyArchiveCsv,
} from "@workspace/domain";

describe("bounded read-only legacy CSV contract", () => {
  it("preserves text identities and unknown dates without computing accounting values", () => {
    const result = parseLegacyArchiveCsv(
      "source_id,type,title,reference,party_name,occurred_on,status,summary\n000081,invoice,Original invoice,00123,Original party,,Paid,Source amount 4.46",
    );
    expect(result.rows[0].data).toEqual({
      sourceId: "000081",
      recordType: "invoice",
      title: "Original invoice",
      reference: "00123",
      partyName: "Original party",
      occurredOn: null,
      status: "Paid",
      summary: "Source amount 4.46",
    });
    expect(result.rows[0].errors).toEqual([]);
  });
  it("reads quoted multiline fields, BOM and tab exports as text only", () => {
    expect(
      parseLegacyArchiveCsv(
        '\uFEFFsource_id\ttype\ttitle\tsummary\r\n0001\tjob\tOriginal job\t"First line\nSecond line"',
        "\t",
      ).rows[0].data.summary,
    ).toBe("First line\nSecond line");
  });
  it("retains formula-shaped source values as inert strings", () => {
    expect(
      parseLegacyArchiveCsv("source_id,type,title\n=1+1,other,=2+2").rows[0]
        .data,
    ).toMatchObject({ sourceId: "=1+1", title: "=2+2" });
  });
  it("reports duplicate identities including the record type without merging", () => {
    const result = parseLegacyArchiveCsv(
      "source_id,type,title\n0001,job,One\n0001,job,Two\n0001,quote,Separate type",
    );
    expect(result.rows.map((row) => row.fileDuplicates)).toEqual([
      [3],
      [2],
      [],
    ]);
  });
  it.each([
    "source_id,type,title,balance_amount\n1,job,One,100",
    "source_id,type,title,title\n1,job,One,Two",
    "type,title\njob,One",
  ])("refuses unsupported or ambiguous headers", (csv) =>
    expect(() => parseLegacyArchiveCsv(csv)).toThrow(/template/),
  );
  it("keeps invalid dates/types and row shape visible for explicit skip or correction", () => {
    const result = parseLegacyArchiveCsv(
      "source_id,type,title,occurred_on\n1,journal,One,2026-02-30\n2,job,Two",
    );
    expect(result.rows[0].errors.join(" ")).toMatch(/type/);
    expect(result.rows[0].errors.join(" ")).toMatch(/date/);
    expect(result.rows[1].errors.join(" ")).toMatch(/field count/);
  });
  it("enforces UTF8 bytes, record count, null and quote boundaries", () => {
    expect(() =>
      parseLegacyArchiveCsv(
        "source_id,type,title\n1,job," + "é".repeat(legacyArchiveMaxBytes / 2),
      ),
    ).toThrow(/1 MiB/);
    expect(() =>
      parseLegacyArchiveCsv(
        "source_id,type,title\n" +
          Array.from({ length: 201 }, (_, i) => `${i},job,Title`).join("\n"),
      ),
    ).toThrow(/200/);
    expect(() =>
      parseLegacyArchiveCsv("source_id,type,title\n1,job,\0"),
    ).toThrow(/null/);
    expect(() =>
      parseLegacyArchiveCsv('source_id,type,title\n1,job,"Open'),
    ).toThrow(/Unclosed/);
  });
});
