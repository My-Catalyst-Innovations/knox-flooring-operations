import { expect, it, vi } from "vitest";
import {
  activeJobDecisionRequest,
  dollarsToCents,
  isDefinitiveInvoiceRejection,
  readActiveJobCsv,
} from "./active-job-import";
it("separates proven API rejections from unknown outcomes and retained request conflicts", () => {
  const rejection = (status: number, code?: string, name = "ApiError") =>
    Object.assign(new Error("Rejected"), {
      name,
      status,
      data: { details: { code } },
    });
  for (const status of [400, 401, 403, 404, 409, 413, 422])
    expect(isDefinitiveInvoiceRejection(rejection(status))).toBe(true);
  for (const failure of [
    new Error("Network failed"),
    rejection(408),
    rejection(500),
    rejection(200, undefined, "ResponseParseError"),
    rejection(409, "invoice_request_identity_conflict"),
  ])
    expect(isDefinitiveInvoiceRejection(failure)).toBe(false);
});
it("uses exact nonnegative integer cents including explicit reviewed zero", () => {
  expect(dollarsToCents("4.46")).toBe(446);
  expect(dollarsToCents("0")).toBe(0);
  expect(dollarsToCents("1.2")).toBe(120);
  for (const value of [
    "",
    "-1",
    "NaN",
    "1e3",
    "1.001",
    " 1",
    "01",
    "90071992547409.92",
  ])
    expect(() => dollarsToCents(value)).toThrow();
});
it("preserves BOM/CRLF/leading-zero original bytes and refuses invalid UTF-8", async () => {
  const source = "\uFEFFsource_id,source_status\r\n00007,Scheduled\r\n",
    bytes = new TextEncoder().encode(source);
  expect(
    await readActiveJobCsv({
      size: bytes.length,
      arrayBuffer: async () => bytes.buffer,
    } as File),
  ).toBe(source);
  await expect(
    readActiveJobCsv({
      size: 1,
      arrayBuffer: async () => new Uint8Array([255]).buffer,
    } as File),
  ).rejects.toThrow("UTF-8");
  const read = vi.fn();
  await expect(
    readActiveJobCsv({ size: 1_048_577, arrayBuffer: read } as unknown as File),
  ).rejects.toThrow("1 MiB");
  expect(read).not.toHaveBeenCalled();
});
it("never echoes server-only snapshots or unsupported review fields", () => {
  expect(
    activeJobDecisionRequest({
      line: 2,
      action: "skip",
      note: "Duplicate source",
      snapshot: { providerToken: "not-a-request-field" },
    }),
  ).toEqual({ line: 2, action: "skip", note: "Duplicate source" });
});
