import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { CustomerImportBatch } from "@workspace/domain";
import { CustomerImportDialog } from "./CustomerImportDialog";
const { operation, refresh } = vi.hoisted(() => ({
  operation: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/operations", () => ({
  operation,
  useRefreshOperations: () => refresh,
  useOperation: () => ({
    data: [
      {
        id: "batch",
        sourceSystem: "fictional",
        batchKey: "batch-1",
        status: "preview",
      },
    ],
  }),
}));
const fingerprint = "a".repeat(64);
const base: CustomerImportBatch = {
  id: "batch",
  sourceSystem: "fictional",
  batchKey: "batch-1",
  fileName: "Fictional.csv",
  sourceSha256: "b".repeat(64),
  headers: ["ID", "Name"],
  mapping: { sourceId: "ID", name: "Name" },
  rows: [
    {
      line: 2,
      data: {
        sourceId: "00001",
        name: "Fictional Household",
        email: "",
        phone: "",
        notes: "",
        address: "",
        city: "",
        state: "",
        zip: "",
      },
      errors: [],
      fileDuplicates: [],
      candidates: [],
      imported: null,
    },
  ],
  status: "preview",
  revision: 1,
  previewFingerprint: fingerprint,
  reviewFingerprint: null,
  decisions: [],
  reviewNote: null,
  approval: null,
  result: null,
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
async function resume(batch: CustomerImportBatch) {
  operation.mockResolvedValueOnce(batch);
  render(<CustomerImportDialog onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Resume a saved batch"), {
    target: { value: "batch" },
  });
  await screen.findByText(/Line 2: Fictional Household/).catch(() => {});
  await waitFor(() =>
    expect(operation).toHaveBeenCalledWith("/customer-imports/batch"),
  );
}
it("requires field mapping before saving a preview", async () => {
  operation.mockResolvedValueOnce({
    headers: ["ID", "Name"],
    rowCount: 1,
    samples: [["00001", "Fictional"]],
  });
  render(<CustomerImportDialog onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Paste customer data"), {
    target: { value: "ID,Name\n00001,Fictional" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read columns" }));
  await screen.findByLabelText("Map sourceId");
  expect(screen.getByRole("button", { name: "Save preview" })).toBeDisabled();
  expect(operation).toHaveBeenCalledExactlyOnceWith(
    "/customer-imports/inspect",
    "POST",
    { csv: "ID,Name\n00001,Fictional", delimiter: "," },
  );
});
it("saves explicit row decisions and the exact stored preview fingerprint", async () => {
  await resume(base);
  fireEvent.change(screen.getByLabelText("Decision for line 2"), {
    target: { value: "create" },
  });
  fireEvent.change(screen.getByLabelText("Batch review note"), {
    target: { value: "Reviewed fictional customer records" },
  });
  operation.mockResolvedValueOnce({ ...base, status: "reviewed", revision: 2 });
  fireEvent.click(screen.getByRole("button", { name: "Save row decisions" }));
  await waitFor(() =>
    expect(operation).toHaveBeenLastCalledWith(
      "/customer-imports/batch/review",
      "POST",
      {
        revision: 1,
        previewFingerprint: fingerprint,
        note: "Reviewed fictional customer records",
        decisions: [{ line: 2, action: "create", note: "" }],
      },
    ),
  );
});
it("requires saved review and confirmation before immutable approval; editing disables approval", async () => {
  await resume({
    ...base,
    status: "reviewed",
    revision: 2,
    decisions: [{ line: 2, action: "create", note: "" }],
    reviewNote: "Reviewed fictional customers",
    reviewFingerprint: fingerprint,
  });
  const approve = screen.getByRole("button", {
    name: "Approve reviewed import",
  });
  expect(approve).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(approve).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Review note for line 2"), {
    target: { value: "Changed decision" },
  });
  expect(approve).toBeDisabled();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(operation).toHaveBeenCalledTimes(1);
});
it("commits only exact approval IDs and retains a failed approval for explicit refresh", async () => {
  await resume({
    ...base,
    status: "approved",
    revision: 3,
    reviewFingerprint: fingerprint,
    approval: {
      id: "saved-approval",
      fingerprint,
      approvedBy: "owner",
      approvedAt: "2026-11-23",
    },
    decisions: [{ line: 2, action: "create", note: "" }],
  });
  operation.mockRejectedValueOnce(
    new Error("Customer matches changed. Refresh and review."),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Commit approved customer import" }),
  );
  await screen.findByRole("alert");
  expect(operation).toHaveBeenLastCalledWith(
    "/customer-imports/batch/commit",
    "POST",
    {
      revision: 3,
      approvalId: "saved-approval",
      approvalFingerprint: fingerprint,
    },
  );
  expect(
    screen.getByRole("button", { name: "Refresh matches and review again" }),
  ).toBeEnabled();
});
it("never offers creation or relinking for an already imported source ID", async () => {
  await resume({
    ...base,
    rows: [
      {
        ...base.rows[0],
        imported: {
          customerId: "original",
          effectiveCustomerId: "merged-target",
          batchId: "original-batch",
        },
      },
    ],
  });
  expect(screen.getByText(/current customer merged-target/)).toBeVisible();
  expect(
    screen.queryByRole("option", { name: "Create a separate customer" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("option", { name: "Skip this source row" }),
  ).toBeInTheDocument();
});
