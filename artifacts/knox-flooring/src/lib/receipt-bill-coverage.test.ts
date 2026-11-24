import { beforeEach, expect, it, vi } from "vitest";
import {
  billOriginalDownload,
  coverageDecimal,
  coverageRateDiffers,
  coveragePriceDiffers,
  coverageRoundingProven,
  coverageRejected,
  coverageUsd,
  uploadBillOriginal,
  type BillDocument,
  type CoverageBillLine,
  type CoverageReceipt,
} from "./receipt-bill-coverage";
const state = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({ customFetch: state.fetch }));
beforeEach(() => vi.clearAllMocks());
it("formats primary USD amounts to cents exactly without classifying a price variance", () => {
  expect(coverageUsd("64.149999999999")).toBe("$64.15");
  expect(coverageUsd("64.155000000000")).toBe("$64.16");
  expect(coverageUsd("-0.005000000000")).toBe("-$0.01");
  expect(coverageUsd("-0.004999999999")).toBe("$0.00");
  expect(coverageUsd("100000000000.000001000000")).toBe("$100,000,000,000.00");
  expect(coverageUsd("1e9")).toBe("Amount unavailable");
  expect(coverageUsd(null)).toBe("Amount unavailable");
  expect(coverageUsd("0.000000000000")).toBe("$0.00");
});
it("compares six-place quantities and acquisition prices exactly without coercing identifiers", () => {
  expect(coverageDecimal("100000000000.000001")).toBe(100000000000000001n);
  expect(coverageDecimal("2.000001")).toBe(2000001n);
  expect(coverageRateDiffers("4.460001", "4.460001")).toBe(false);
  expect(coverageRateDiffers("4.460000", "4.46")).toBe(false);
  expect(coverageRateDiffers("4.460001", "4.460002")).toBe(true);
  for (const value of [
    "1e2",
    "-2",
    "2.0000001",
    "NaN",
    "",
    "1,000",
    "0002.000001",
    "1000000000000",
    "1".repeat(33),
  ])
    expect(coverageDecimal(value)).toBeNull();
});
it("waives a variance explanation only for complete approved conversion evidence", () => {
  const receipt = { unitCost: "3.286372" } as CoverageReceipt;
  const bill = {
    unitCost: "3.286373",
    quantity: "19.52",
    roundingSource: {
      version: 1,
      buyQuantity: "1",
      buyUnitCost: "64.15",
      approvedBuyUnitCost: "64.15",
      stockUnitsPerBuyUnit: "19.52",
      approvedStockUnitsPerBuyUnit: "19.52",
      printedLineAmountCents: "6415",
      stockQuantity: "19.52",
      billedStockUnitCost: "3.286373",
    },
  } as CoverageBillLine;
  expect(coverageRoundingProven(receipt, bill)).toBe(true);
  expect(coveragePriceDiffers(receipt, bill)).toBe(false);
  for (const mutation of [
    { approvedBuyUnitCost: "64.16" },
    { approvedStockUnitsPerBuyUnit: "19.53" },
    { printedLineAmountCents: "6416" },
    { stockQuantity: "19.53" },
    { billedStockUnitCost: "3.286372" },
  ]) {
    const changed = {
      ...bill,
      roundingSource: { ...bill.roundingSource!, ...mutation },
    };
    expect(coverageRoundingProven(receipt, changed)).toBe(false);
    expect(coveragePriceDiffers(receipt, changed)).toBe(true);
  }
  expect(
    coveragePriceDiffers(receipt, { ...bill, roundingSource: undefined }),
  ).toBe(true);
  expect(coveragePriceDiffers({ ...receipt, unitCost: "3.280000" }, bill)).toBe(
    true,
  );
});
it("unlocks only definitive API rejections, retaining network, timeout, parse and server uncertainty", () => {
  const failure = (status: number, name = "ApiError") =>
    Object.assign(new Error("Rejected"), { name, status });
  for (const status of [400, 403, 409, 422])
    expect(coverageRejected(failure(status))).toBe(true);
  for (const value of [
    failure(408),
    failure(500),
    failure(200, "ResponseParseError"),
    new Error("network"),
    { name: "ApiError", status: 409 },
  ])
    expect(coverageRejected(value)).toBe(false);
  const accessor = Object.assign(new Error("untrusted"), { name: "ApiError" });
  Object.defineProperty(accessor, "status", {
    get() {
      throw new Error("Getter must not execute");
    },
  });
  expect(coverageRejected(accessor)).toBe(false);
});
it("uploads only an explicitly selected supported original to the exact private bill purpose", async () => {
  state.fetch.mockResolvedValue({
    objectPath: "/objects/files/vendor-bill-document/a",
  });
  const file = new File(["%PDF"], "Original #001.pdf", {
    type: "application/pdf",
  });
  await uploadBillOriginal(file, "bill/0001");
  expect(state.fetch).toHaveBeenCalledExactlyOnceWith(
    "/api/storage/files/vendor-bill-document?recordId=bill%2F0001",
    expect.objectContaining({
      method: "POST",
      body: file,
      headers: {
        "Content-Type": "application/octet-stream",
        "x-file-name": "Original%20%23001.pdf",
      },
    }),
  );
  for (const file of [
    new File([], "Empty.pdf", { type: "application/pdf" }),
    new File(["x"], "Unknown.html", { type: "text/html" }),
  ])
    await expect(uploadBillOriginal(file, "bill")).rejects.toThrow("10 MiB");
  const huge = new File(["x"], "Huge.pdf", { type: "application/pdf" });
  Object.defineProperty(huge, "size", { value: 10 * 1024 * 1024 + 1 });
  await expect(uploadBillOriginal(huge, "bill")).rejects.toThrow("10 MiB");
  expect(state.fetch).toHaveBeenCalledTimes(1);
});
it("permits only the exact saved document attachment path for the current bill", () => {
  const document: BillDocument = {
    id: "doc-a",
    billId: "bill-a",
    fileName: "Original.pdf",
    size: 5,
    sha256: "a".repeat(64),
    createdAt: "2026-11-23T12:00:00Z",
    downloadUrl: "/api/quickbooks/vendor-bills/documents/doc-a/download",
  };
  expect(billOriginalDownload(document, "bill-a")).toBe(document.downloadUrl);
  for (const downloadUrl of [
    "https://elsewhere.invalid/file",
    "/api/quickbooks/vendor-bills/documents/other/download",
    document.downloadUrl + "?redirect=x",
    "javascript:alert(1)",
  ])
    expect(
      billOriginalDownload({ ...document, downloadUrl }, "bill-a"),
    ).toBeNull();
  expect(billOriginalDownload(document, "another-bill")).toBeNull();
});
