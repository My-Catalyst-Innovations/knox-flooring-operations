import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupplierImportBatch } from "@workspace/domain";
import {
  supplierBatch,
  supplierContact,
} from "@/test/supplier-contact-fixtures";
import { SupplierContactImport } from "./SupplierContactImport";
const state = vi.hoisted(() => ({
  user: { role: "owner", previewRole: null } as any,
  operation: vi.fn(),
  refetch: vi.fn(),
  committed: vi.fn(),
  queries: [] as string[],
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/operations", () => ({
  operation: state.operation,
  useOperation: (path: string, roles: string[]) => {
    const allowed = !!state.user && roles.includes(state.user.role);
    if (allowed) state.queries.push(path);
    return {
      data: allowed
        ? path === "/supplier-imports"
          ? [{ ...supplierBatch }]
          : { suppliers: [supplierContact], hasMore: false, page: 0 }
        : undefined,
      refetch: state.refetch,
      isError: false,
    };
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.operation.mockReset();
  state.user = { role: "owner", previewRole: null };
  state.queries = [];
});
afterEach(cleanup);
async function resume(
  value: SupplierImportBatch = structuredClone(supplierBatch),
) {
  state.operation.mockResolvedValueOnce(value);
  render(
    <SupplierContactImport onClose={vi.fn()} onCommitted={state.committed} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /legacy-test \/ source-2020/ }),
  );
  await screen.findByText("Line 2: Historical source label");
  return value;
}
it.each([
  null,
  { role: "sales" },
  { role: "operations" },
  { role: "installer" },
  { role: "owner", previewRole: "installer" },
])(
  "keeps import queries and controls unavailable outside actual owner mode: %j",
  (user) => {
    state.user = user;
    render(
      <SupplierContactImport onClose={vi.fn()} onCommitted={state.committed} />,
    );
    expect(state.queries).toEqual([]);
    expect(state.operation).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);
it("opening the importer performs only authorized reads until explicit preview", () => {
  render(
    <SupplierContactImport onClose={vi.fn()} onCommitted={state.committed} />,
  );
  expect(state.queries).toContain("/supplier-imports");
  expect(state.operation).not.toHaveBeenCalled();
  expect(
    screen.getByRole("link", { name: "Download supplier contact template" }),
  ).toHaveAttribute("href", "/api/supplier-imports/template");
});
it("requires an explicit row decision and saves only reviewed create fields", async () => {
  await resume();
  const save = screen.getByRole("button", { name: "Save supplier review" });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Batch review note"), {
    target: { value: "Verified original contact source" },
  });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Decision for line 2"), {
    target: { value: "create" },
  });
  state.operation.mockResolvedValueOnce({
    ...supplierBatch,
    status: "reviewed",
    revision: 2,
  });
  fireEvent.click(save);
  await waitFor(() =>
    expect(state.operation).toHaveBeenLastCalledWith(
      `/supplier-imports/${supplierBatch.id}/review`,
      "POST",
      {
        revision: 1,
        previewFingerprint: supplierBatch.previewFingerprint,
        note: "Verified original contact source",
        decisions: [{ line: 2, action: "create", note: "" }],
      },
    ),
  );
});
it("links the explicitly selected current supplier without submitting source contacts or a client-provided snapshot", async () => {
  await resume();
  fireEvent.change(screen.getByLabelText("Decision for line 2"), {
    target: { value: "link" },
  });
  fireEvent.change(screen.getByLabelText("Existing supplier for line 2"), {
    target: { value: supplierContact.id },
  });
  fireEvent.change(screen.getByLabelText("Review reason for line 2"), {
    target: { value: "Owner checked the existing legal supplier" },
  });
  fireEvent.change(screen.getByLabelText("Batch review note"), {
    target: { value: "Verified source labels without overwrite" },
  });
  state.operation.mockResolvedValueOnce({
    ...supplierBatch,
    status: "reviewed",
    revision: 2,
  });
  fireEvent.click(screen.getByRole("button", { name: "Save supplier review" }));
  await waitFor(() =>
    expect(state.operation).toHaveBeenLastCalledWith(
      `/supplier-imports/${supplierBatch.id}/review`,
      "POST",
      {
        revision: 1,
        previewFingerprint: supplierBatch.previewFingerprint,
        note: "Verified source labels without overwrite",
        decisions: [
          {
            line: 2,
            action: "link",
            supplierId: supplierContact.id,
            supplierRevision: 2,
            note: "Owner checked the existing legal supplier",
          },
        ],
      },
    ),
  );
});
it("retains exact uploaded BOM/CRLF source text through explicit preview", async () => {
  render(
    <SupplierContactImport onClose={vi.fn()} onCommitted={state.committed} />,
  );
  fireEvent.change(screen.getByLabelText("Source system ID"), {
    target: { value: "legacy-test" },
  });
  fireEvent.change(screen.getByLabelText("Source batch ID"), {
    target: { value: "original-2020" },
  });
  const csv = "\uFEFFsource_id,name\r\n000081,Original Supply\r\n",
    bytes = new TextEncoder().encode(csv),
    file = new File([bytes], "Original.csv");
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer,
  });
  fireEvent.change(screen.getByLabelText("Choose supplier CSV or TSV"), {
    target: { files: [file] },
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Source file label")).toHaveValue(
      "Original.csv",
    ),
  );
  expect(state.operation).not.toHaveBeenCalled();
  state.operation.mockResolvedValueOnce(supplierBatch);
  fireEvent.click(
    screen.getByRole("button", { name: "Save supplier preview" }),
  );
  await waitFor(() =>
    expect(state.operation).toHaveBeenCalledWith(
      "/supplier-imports/preview",
      "POST",
      {
        sourceSystem: "legacy-test",
        batchKey: "original-2020",
        fileName: "Original.csv",
        csv,
        delimiter: ",",
      },
    ),
  );
});
it.each(["invalid UTF8", "oversize", "unreadable"])(
  "discards a previous source after a newly chosen file is %s",
  async (failure) => {
    render(
      <SupplierContactImport onClose={vi.fn()} onCommitted={state.committed} />,
    );
    fireEvent.change(screen.getByLabelText("Source system ID"), {
      target: { value: "legacy-test" },
    });
    fireEvent.change(screen.getByLabelText("Source batch ID"), {
      target: { value: "batch" },
    });
    fireEvent.change(screen.getByLabelText("Paste supplier data"), {
      target: { value: "source_id,name\n1,Old file" },
    });
    const file = new File([new Uint8Array([255])], "New.csv");
    Object.defineProperty(file, "arrayBuffer", {
      value:
        failure === "unreadable"
          ? async () => {
              throw new Error("Read failed");
            }
          : async () => new Uint8Array([255]).buffer,
    });
    if (failure === "oversize")
      Object.defineProperty(file, "size", { value: 1048577 });
    fireEvent.change(screen.getByLabelText("Choose supplier CSV or TSV"), {
      target: { files: [file] },
    });
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Paste supplier data")).toHaveValue("");
    expect(screen.getByLabelText("Source file label")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Save supplier preview" }),
    ).toBeDisabled();
    expect(state.operation).not.toHaveBeenCalled();
  },
);
it("invalidates approval confirmation when a saved review is changed", async () => {
  await resume({
    ...structuredClone(supplierBatch),
    status: "reviewed",
    revision: 2,
    reviewNote: "Saved owner review",
    reviewFingerprint: "c".repeat(64),
    decisions: [{ line: 2, action: "create", note: "" }],
  });
  const checkbox = screen.getByRole("checkbox");
  fireEvent.click(checkbox);
  expect(
    screen.getByRole("button", { name: "Record owner approval" }),
  ).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Batch review note"), {
    target: { value: "Changed review requires saving" },
  });
  expect(checkbox).toBeDisabled();
  expect(checkbox).not.toBeChecked();
  expect(
    screen.getByRole("button", { name: "Record owner approval" }),
  ).toBeDisabled();
  expect(state.operation).toHaveBeenCalledTimes(1);
});
it("retries a lost commit response only with the same immutable approval and reports success after persistence is known", async () => {
  const approved = {
    ...structuredClone(supplierBatch),
    status: "approved" as const,
    revision: 3,
    reviewNote: "Saved review",
    reviewFingerprint: "c".repeat(64),
    decisions: [{ line: 2, action: "create" as const, note: "" }],
    approval: {
      id: "00000000-0000-4000-8000-000000000003",
      fingerprint: "c".repeat(64),
      approvedBy: "owner",
      approvedAt: "2026-11-23",
    },
  };
  await resume(approved);
  state.operation.mockRejectedValueOnce(
    new Error("Lost response; check saved import before retry"),
  );
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Commit approved supplier import" }),
  );
  await screen.findByRole("alert");
  expect(state.committed).not.toHaveBeenCalled();
  state.operation.mockResolvedValueOnce({
    ...approved,
    status: "committed",
    revision: 4,
    result: {
      created: 1,
      linked: 0,
      skipped: 0,
      supplierIds: [supplierContact.id],
    },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Commit approved supplier import" }),
  );
  await screen.findByText(/Supplier import saved: 1 created/);
  expect(state.committed).toHaveBeenCalledOnce();
  const commits = state.operation.mock.calls.filter(([path]) =>
    path.endsWith("/commit"),
  );
  expect(commits).toHaveLength(2);
  expect(commits[0]).toEqual(commits[1]);
  expect(commits[0][2]).toEqual({
    revision: 3,
    approvalId: approved.approval.id,
    approvalFingerprint: approved.approval.fingerprint,
    confirmContactsOnly: true,
  });
});
