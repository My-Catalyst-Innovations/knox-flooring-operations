import { describe, expect, it } from "vitest";
import { parseActiveJobCsv } from "@workspace/domain";
import { readCsv } from "@workspace/domain";
describe("active-job source parsing without operational or financial facts", () => {
  it("retains exact leading-zero IDs, original unsupported stage and source timestamps", () => {
    const source =
      "\uFEFFsource_id,source_status,source_job_number,source_stage_at\r\n000081,  Forza Installing  ,000012,2026-11-01T01:30:00.1234567-04:00\r\n";
    const row = parseActiveJobCsv(source).rows[0];
    expect(row.data).toMatchObject({
      source_id: "000081",
      source_status: "  Forza Installing  ",
      source_job_number: "000012",
      source_stage_at: "2026-11-01T01:30:00.1234567-04:00",
    });
    expect(row.errors).toEqual([]);
    expect(row.recognizedStage).toBeNull();
    expect(row.warnings.join(" ")).toMatch(/explicit supported-stage/);
  });
  it("leaves unknown dates and area blank instead of inventing current timestamps or zero money", () => {
    const row = parseActiveJobCsv("source_id,source_status\n1,Approved")
      .rows[0];
    expect(row.data.sold_at).toBe("");
    expect(row.data.source_created_at).toBe("");
    expect(row.data.square_feet).toBe("");
    expect(row.data).not.toHaveProperty("actualRevenue");
    expect(row.errors).toEqual([]);
  });
  it.each(["Scheduled", "In Progress", "Final Walkthrough"])(
    "retains %s only as a source claim, never a booking",
    (status) => {
      const row = parseActiveJobCsv(`source_id,source_status\n1,${status}`)
        .rows[0];
      expect(row.data.source_status).toBe(status);
      expect(row.warnings.join(" ")).toMatch(
        /does not establish a real crew booking/,
      );
    },
  );
  it.each(["Completed", "Invoiced"])(
    "refuses closed %s jobs rather than silently reopening them",
    (status) =>
      expect(
        parseActiveJobCsv(
          `source_id,source_status\n1,${status}`,
        ).rows[0].errors.join(" "),
      ).toMatch(/historical archive/),
  );
  it("refuses ambiguous local times, calendar rollover and whitespace-normalized source identities", () => {
    const row = parseActiveJobCsv(
      "source_id,source_status,source_created_at,est_start_on,est_completion_on\n 001 ,Approved,2026-11-23T09:00:00,2026-02-30,0000-01-01",
    ).rows[0];
    expect(row.data.source_id).toBe(" 001 ");
    expect(row.errors.join(" ")).toMatch(/IDs are never normalized/);
    expect(row.errors.join(" ")).toMatch(/explicit-offset/);
    expect(row.errors.join(" ")).toMatch(/YYYY-MM-DD/);
  });
  it("retains date-only source events with explicit unknown-time precision rather than inventing midnight", () => {
    const row = parseActiveJobCsv(
      "source_id,source_status,sold_at\n001,Approved,2026-11-23",
    ).rows[0];
    expect(row.data.sold_at).toBe("2026-11-23");
    expect(row.errors).toEqual([]);
    expect(row.warnings.join(" ")).toMatch(/unknown time/);
    expect(row.data.sold_at).not.toContain("T");
  });
  it("refuses financial columns rather than initializing verified legacy money", () =>
    expect(() =>
      parseActiveJobCsv(
        "source_id,source_status,balance_amount\n1,Approved,430.10",
      ),
    ).toThrow(/financial/));
  it("supports exact quoted labels and leaves every existing CSV caller's trimming behavior unchanged", () => {
    expect(readCsv('source_id,name\n 001 ," Supply "')[1].fields).toEqual([
      "001",
      "Supply",
    ]);
    expect(
      parseActiveJobCsv(
        'source_id,source_status,scope_of_work\n001,Approved,"  Exact source instructions  "',
      ).rows[0].data.scope_of_work,
    ).toBe("  Exact source instructions  ");
  });
  it("flags duplicate identities and refuses excessive source rows", () => {
    expect(
      parseActiveJobCsv(
        "source_id,source_status\n001,Approved\n001,Material Ordered",
      ).rows[0].fileDuplicates,
    ).toEqual([3]);
    expect(() =>
      parseActiveJobCsv(
        "source_id,source_status\n" +
          Array.from({ length: 201 }, (_, i) => `${i},Approved`).join("\n"),
      ),
    ).toThrow(/200/);
  });
});
