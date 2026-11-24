import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openPoImportColumns, type OpenPoImportBatch } from "@workspace/domain";
import {
  importDecision,
  importProduct,
  importSource,
  importSupplier,
  importWarehouse,
  openPoBatch,
} from "@/test/open-po-import-fixtures";
import OpenPoImports from "./open-po-imports";
const state = vi.hoisted(() => ({
  user: {
    role: "owner",
    actualRole: "owner",
    previewRole: null as string | null,
  },
  initialId: "",
  batch: null as OpenPoImportBatch | null,
  operation: vi.fn(),
  refetch: vi.fn(),
  queries: [] as Array<{ path: string; roles: string[] }>,
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/hooks/use-url-state", async () => {
  const { useState } = await import("react");
  return { useUrlState: () => useState(state.initialId) };
});
vi.mock("@/lib/operations", () => ({
  operation: state.operation,
  useOperation: (path: string, roles: string[]) => {
    state.queries.push({ path, roles });
    const permitted = roles.includes(state.user.role);
    if (path === "/open-po-imports")
      return {
        data: permitted && state.batch ? [state.batch] : [],
        refetch: state.refetch,
      };
    if (path.startsWith("/open-po-imports/options")) {
      const kind = new URLSearchParams(path.split("?")[1]).get("kind");
      return {
        data: permitted
          ? {
              items:
                kind === "supplier"
                  ? [importSupplier]
                  : kind === "warehouse"
                    ? [importWarehouse]
                    : kind === "product"
                      ? [importProduct]
                      : [],
              hasMore: false,
              page: 0,
            }
          : undefined,
        refetch: state.refetch,
      };
    }
    return {
      data: permitted ? state.batch : undefined,
      refetch: state.refetch,
    };
  },
}));
beforeEach(() => {
  state.user = { role: "owner", actualRole: "owner", previewRole: null };
  state.initialId = "";
  state.batch = null;
  state.operation.mockReset();
  state.refetch.mockReset();
  state.queries = [];
  window.history.replaceState({}, "", "/");
});
afterEach(cleanup);
async function show(batch: OpenPoImportBatch) {
  state.batch = batch;
  state.initialId = batch.id;
  render(<OpenPoImports />);
  await screen.findByRole("heading", { name: "Source PO 000078" });
}
function sourceForm() {
  for (const [label, value] of [
    ["Source system ID", "legacy-test"],
    ["Source batch ID", "open-orders-2026"],
    ["Source snapshot timestamp", "2026-11-23T14:00:00-05:00"],
    ["Cutover timestamp", "2026-11-23T15:00:00-05:00"],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const csv =
    openPoImportColumns.join(",") +
    "\n00001,000078,000001,Partially received,Original supplier ref,Original office ref,,000012,sq ft,12.300001,2.1,0.2,10.000001,4.460001,USD,2026-12-01";
  fireEvent.change(screen.getByLabelText("Paste source CSV or TSV"), {
    target: { value: csv },
  });
  return csv;
}
it("opens without writes and saves exact explicitly entered source snapshot only after a click", async () => {
  render(<OpenPoImports />);
  expect(state.operation).not.toHaveBeenCalled();
  expect(screen.queryByText("Source PO 000078")).not.toBeInTheDocument();
  const csv = sourceForm();
  state.operation.mockResolvedValueOnce(openPoBatch());
  fireEvent.click(screen.getByRole("button", { name: "Save source preview" }));
  await screen.findByRole("heading", { name: "Source PO 000078" });
  expect(state.operation).toHaveBeenCalledExactlyOnceWith(
    "/open-po-imports/preview",
    "POST",
    expect.objectContaining({
      csv,
      sourceSnapshotAt: "2026-11-23T14:00:00-05:00",
      cutoverAt: "2026-11-23T15:00:00-05:00",
      delimiter: ",",
    }),
  );
  expect(screen.getByText("12.300001")).toBeVisible();
  expect(screen.getByText("2.1")).toBeVisible();
  expect(screen.getByText("10.000001")).toBeVisible();
});
it("requires explicit local links, every line decision and both outstanding confirmations before saved review", async () => {
  const batch = openPoBatch();
  await show(batch);
  fireEvent.change(screen.getByLabelText("Decision for source PO 00001"), {
    target: { value: "create" },
  });
  fireEvent.change(screen.getByLabelText("Review note for source PO 00001"), {
    target: { value: importDecision.note },
  });
  expect(
    screen.getByRole("button", { name: "Save reviewed mappings" }),
  ).toBeDisabled();
  for (const [label, value] of [
    ["supplier for 00001", "Reviewed supplier"],
    ["warehouse for 00001", "Office warehouse"],
  ]) {
    fireEvent.click(screen.getByRole("button", { name: `Choose ${label}` }));
    fireEvent.click(screen.getByRole("button", { name: value }));
  }
  fireEvent.change(screen.getByLabelText("Job link for 00001"), {
    target: { value: "none" },
  });
  fireEvent.change(screen.getByLabelText("Decision for line 2"), {
    target: { value: "include" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Choose stock product for line 2" }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "000012 · Selected stock product · sq ft",
    }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I verified this source order/ }),
  );
  fireEvent.change(screen.getByLabelText("Batch review note"), {
    target: { value: "Reviewed actual source and linked operational records" },
  });
  expect(
    screen.getByRole("button", { name: "Save reviewed mappings" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Carry forward only remaining/ }),
  );
  state.operation.mockResolvedValueOnce(openPoBatch("reviewed"));
  fireEvent.click(
    screen.getByRole("button", { name: "Save reviewed mappings" }),
  );
  await waitFor(() => expect(state.operation).toHaveBeenCalledOnce());
  expect(state.operation).toHaveBeenCalledWith(
    `/open-po-imports/${batch.id}/review`,
    "POST",
    expect.objectContaining({
      revision: 1,
      previewFingerprint: batch.previewFingerprint,
      decisions: [
        expect.objectContaining({
          supplierId: importSupplier.id,
          supplierRevision: 2,
          warehouseId: importWarehouse.id,
          warehouseUpdatedAt: importWarehouse.updatedAt,
          jobId: null,
          sourceOpenConfirmed: true,
          outstandingOnlyConfirmed: true,
          lines: [
            expect.objectContaining({
              line: 2,
              action: "include",
              productId: importProduct.id,
              productRevision: 3,
            }),
          ],
        }),
      ],
    }),
  );
});
it("invalidates saved approval when a reviewed mapping or note changes", async () => {
  const batch = openPoBatch("reviewed");
  await show(batch);
  const approve = screen.getByRole("button", {
    name: "Approve saved outstanding-only review",
  });
  expect(approve).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the exact saved source/ }),
  );
  expect(approve).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Review note for source PO 00001"), {
    target: { value: "Changed owner note" },
  });
  expect(approve).toBeDisabled();
  expect(
    screen.getByRole("checkbox", { name: /I reviewed the exact saved source/ }),
  ).not.toBeChecked();
  expect(state.operation).not.toHaveBeenCalled();
});
it("approves only the exact saved fingerprint after explicit outstanding-only confirmation", async () => {
  const batch = openPoBatch("reviewed");
  await show(batch);
  state.operation.mockResolvedValueOnce(openPoBatch("approved"));
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the exact saved source/ }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Approve saved outstanding-only review",
    }),
  );
  await waitFor(() =>
    expect(state.operation).toHaveBeenCalledWith(
      `/open-po-imports/${batch.id}/approve`,
      "POST",
      {
        revision: 2,
        reviewFingerprint: batch.reviewFingerprint,
        confirmOutstandingOnly: true,
      },
    ),
  );
  expect(
    screen.getByRole("button", { name: "Commit approved remaining orders" }),
  ).toBeDisabled();
});
it("retains the exact approved commit for an explicit retry after a lost response", async () => {
  const batch = openPoBatch("approved");
  await show(batch);
  state.operation
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockResolvedValueOnce({
      ...openPoBatch("committed"),
      result: {
        created: 1,
        linked: 0,
        skipped: 0,
        orders: [
          {
            sourcePoId: "00001",
            sourcePoNumber: "000078",
            orderId: "order-a",
            orderNumber: "PO-000123",
            action: "create",
          },
        ],
      },
    });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /Commit this approved snapshot once/,
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Commit approved remaining orders" }),
  );
  await screen.findByRole("alert");
  fireEvent.click(
    screen.getByRole("button", { name: "Commit approved remaining orders" }),
  );
  await screen.findByRole("link", { name: "PO-000123" });
  expect(state.operation).toHaveBeenCalledTimes(2);
  expect(state.operation.mock.calls[0]).toEqual(state.operation.mock.calls[1]);
  expect(state.operation.mock.calls[0][2]).toEqual({
    revision: 3,
    approvalId: batch.approval!.id,
    approvalFingerprint: batch.approval!.fingerprint,
    confirmOutstandingOnly: true,
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "No stock or earlier receipts were imported",
  );
});
it("clears a previous source before a newly selected invalid UTF8 file can fail", async () => {
  render(<OpenPoImports />);
  sourceForm();
  const file = new File([new Uint8Array([255])], "Bad.csv", {
    type: "text/csv",
  });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new Uint8Array([255]).buffer,
  });
  fireEvent.change(screen.getByLabelText("Choose outstanding PO CSV or TSV"), {
    target: { files: [file] },
  });
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Paste source CSV or TSV")).toHaveValue("");
  expect(screen.getByLabelText("Source file label")).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "Save source preview" }),
  ).toBeDisabled();
  expect(state.operation).not.toHaveBeenCalled();
});
it("retains chosen UTF8 BOM and CRLF bytes in the explicitly saved preview", async () => {
  render(<OpenPoImports />);
  const plain = sourceForm(),
    csv = "\uFEFF" + plain.replaceAll("\n", "\r\n") + "\r\n";
  const bytes = new TextEncoder().encode(csv),
    file = new File([bytes], "Original source.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer,
  });
  fireEvent.change(screen.getByLabelText("Choose outstanding PO CSV or TSV"), {
    target: { files: [file] },
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Source file label")).toHaveValue(
      "Original source.csv",
    ),
  );
  expect(state.operation).not.toHaveBeenCalled();
  state.operation.mockResolvedValueOnce(openPoBatch());
  fireEvent.click(screen.getByRole("button", { name: "Save source preview" }));
  await waitFor(() =>
    expect(state.operation).toHaveBeenCalledExactlyOnceWith(
      "/open-po-imports/preview",
      "POST",
      expect.objectContaining({ csv, fileName: "Original source.csv" }),
    ),
  );
});
it("keeps hostile source IDs and original source text inert while allowing explicit skip", async () => {
  const batch = openPoBatch();
  batch.rows[0].sourcePoId = "__proto__";
  batch.rows[0].lines[0].sourcePoId = "__proto__";
  batch.rows[0].lines[0].sourceStatus = "<img src=x onerror=alert(1)>";
  await show(batch);
  expect(
    screen.getByText(
      "Source ID __proto__ · Original status: <img src=x onerror=alert(1)>",
    ),
  ).toBeVisible();
  expect(document.querySelector("img")).toBeNull();
  fireEvent.change(screen.getByLabelText("Decision for source PO __proto__"), {
    target: { value: "skip" },
  });
  expect(
    screen.getByLabelText("Review note for source PO __proto__"),
  ).toBeInTheDocument();
  expect(state.operation).not.toHaveBeenCalled();
});
it.each([
  { role: "sales", actualRole: "sales", previewRole: null },
  { role: "operations", actualRole: "operations", previewRole: null },
  { role: "installer", actualRole: "installer", previewRole: null },
  { role: "owner", actualRole: "owner", previewRole: "sales" },
])(
  "hides cached import data and disables queries for $role / $previewRole",
  (user) => {
    state.user = user;
    state.batch = openPoBatch();
    state.initialId = state.batch.id;
    render(<OpenPoImports />);
    expect(
      screen.getByText(
        "Outstanding purchase-order imports require an owner outside role preview.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Source PO 000078")).not.toBeInTheDocument();
    expect(state.queries.every((query) => query.roles.length === 0)).toBe(true);
    expect(state.operation).not.toHaveBeenCalled();
  },
);
