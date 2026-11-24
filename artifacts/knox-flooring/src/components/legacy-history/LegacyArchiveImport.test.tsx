import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LegacyArchiveBatch } from "@workspace/domain";
import { archiveBatch } from "@/test/legacy-history-fixtures";
import { LegacyArchiveImport } from "./LegacyArchiveImport";
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
        ? [
            {
              id: "batch-a",
              sourceSystem: "legacy-test",
              batchKey: "original-2020",
              status: "preview",
            },
          ]
        : undefined,
      refetch: state.refetch,
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
async function resume(value: LegacyArchiveBatch) {
  state.operation.mockResolvedValueOnce(value);
  render(
    <LegacyArchiveImport onClose={vi.fn()} onCommitted={state.committed} />,
  );
  fireEvent.change(screen.getByLabelText("Resume a saved history batch"), {
    target: { value: "batch-a" },
  });
  await screen.findByText("Line 2: Historical invoice");
  expect(state.operation).toHaveBeenCalledWith(
    "/legacy-history/imports/batch-a",
  );
}
function reviewed(): LegacyArchiveBatch {
  return {
    ...structuredClone(archiveBatch),
    status: "reviewed",
    revision: 2,
    decisions: [{ line: 2, action: "archive", note: "" }],
    reviewNote: "Reviewed original historical source",
    reviewFingerprint: "f".repeat(64),
  };
}
function approved(): LegacyArchiveBatch {
  return {
    ...reviewed(),
    status: "approved",
    revision: 3,
    approval: {
      id: "approval-a",
      fingerprint: "f".repeat(64),
      approvedBy: "owner-a",
      approvedAt: "2026-11-23T16:00:00Z",
    },
  };
}

it("opens read-only and previews exact pasted source data only after explicit action", async () => {
  render(
    <LegacyArchiveImport onClose={vi.fn()} onCommitted={state.committed} />,
  );
  expect(state.operation).not.toHaveBeenCalled();
  const csv = "source_id,type,title\n00001,invoice,Historical invoice\n";
  fireEvent.change(screen.getByLabelText("Source system ID"), {
    target: { value: "legacy-test" },
  });
  fireEvent.change(screen.getByLabelText("Source batch ID"), {
    target: { value: "original-2020" },
  });
  fireEvent.change(screen.getByLabelText("Source file label"), {
    target: { value: "Original history.csv" },
  });
  fireEvent.change(screen.getByLabelText("Paste historical data"), {
    target: { value: csv },
  });
  state.operation.mockResolvedValueOnce(archiveBatch);
  fireEvent.click(screen.getByRole("button", { name: "Save archive preview" }));
  await screen.findByText("Line 2: Historical invoice");
  expect(state.operation).toHaveBeenCalledExactlyOnceWith(
    "/legacy-history/imports/preview",
    "POST",
    {
      sourceSystem: "legacy-test",
      batchKey: "original-2020",
      fileName: "Original history.csv",
      csv,
      delimiter: ",",
    },
  );
  expect(
    screen.getByRole("link", { name: "Download original source CSV" }),
  ).toHaveAttribute("href", "/api/legacy-history/imports/batch-a/source");
  expect(
    screen.queryByRole("button", { name: "Save approved archive" }),
  ).not.toBeInTheDocument();
});
it("requires an explicit decision for every row and a reason for skipped invalid identities", async () => {
  const batch = structuredClone(archiveBatch);
  batch.rows.push({
    ...structuredClone(batch.rows[0]),
    line: 3,
    data: {
      ...batch.rows[0].data,
      sourceId: "00002",
      title: "Conflicting history",
      recordType: "__proto__" as any,
    },
    errors: ["Invalid source row"],
    existing: { id: "existing-archive", recordSha256: "e".repeat(64) },
  });
  await resume(batch);
  expect(
    screen
      .getByLabelText("Decision for line 3")
      .querySelector('option[value="archive"]'),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Decision for line 2"), {
    target: { value: "archive" },
  });
  fireEvent.change(screen.getByLabelText("Decision for line 3"), {
    target: { value: "skip" },
  });
  fireEvent.change(screen.getByLabelText("Batch review note"), {
    target: { value: "Reviewed historical source identities" },
  });
  expect(
    screen.getByRole("button", { name: "Save archive decisions" }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Review note for line 3"), {
    target: { value: "Keep the original retained identity" },
  });
  state.operation.mockResolvedValueOnce({
    ...batch,
    status: "reviewed",
    revision: 2,
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save archive decisions" }),
  );
  await waitFor(() =>
    expect(state.operation).toHaveBeenLastCalledWith(
      "/legacy-history/imports/batch-a/review",
      "POST",
      {
        revision: 1,
        previewFingerprint: archiveBatch.previewFingerprint,
        note: "Reviewed historical source identities",
        decisions: [
          { line: 2, action: "archive", note: "" },
          {
            line: 3,
            action: "skip",
            note: "Keep the original retained identity",
          },
        ],
      },
    ),
  );
});
it("preserves chosen UTF-8 source-file bytes, including BOM and CRLF, until explicit preview", async () => {
  render(
    <LegacyArchiveImport onClose={vi.fn()} onCommitted={state.committed} />,
  );
  fireEvent.change(screen.getByLabelText("Source system ID"), {
    target: { value: "legacy-test" },
  });
  fireEvent.change(screen.getByLabelText("Source batch ID"), {
    target: { value: "original-2020" },
  });
  const csv =
    "\uFEFFsource_id,type,title\r\n00001,invoice,Historical invoice\r\n";
  const bytes = new TextEncoder().encode(csv);
  const file = new File([bytes], "Original history.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer,
  });
  fireEvent.change(screen.getByLabelText("Choose history CSV or TSV"), {
    target: { files: [file] },
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Source file label")).toHaveValue(
      "Original history.csv",
    ),
  );
  expect(state.operation).not.toHaveBeenCalled();
  state.operation.mockResolvedValueOnce(archiveBatch);
  fireEvent.click(screen.getByRole("button", { name: "Save archive preview" }));
  await screen.findByText("Line 2: Historical invoice");
  expect(state.operation).toHaveBeenCalledExactlyOnceWith(
    "/legacy-history/imports/preview",
    "POST",
    {
      sourceSystem: "legacy-test",
      batchKey: "original-2020",
      fileName: "Original history.csv",
      csv,
      delimiter: ",",
    },
  );
});
it.each(["invalid UTF-8", "oversize", "unreadable"])(
  "discards the previous source when a newly selected file is %s",
  async (failure) => {
    render(
      <LegacyArchiveImport onClose={vi.fn()} onCommitted={state.committed} />,
    );
    fireEvent.change(screen.getByLabelText("Source system ID"), {
      target: { value: "legacy-test" },
    });
    fireEvent.change(screen.getByLabelText("Source batch ID"), {
      target: { value: "original-2020" },
    });
    fireEvent.change(screen.getByLabelText("Source file label"), {
      target: { value: "Previous source.csv" },
    });
    fireEvent.change(screen.getByLabelText("Paste historical data"), {
      target: { value: "source_id,type,title\n0001,job,Previous history" },
    });
    expect(
      screen.getByRole("button", { name: "Save archive preview" }),
    ).toBeEnabled();
    const file = new File([new Uint8Array([255])], "New source.csv", {
      type: "text/csv",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value:
        failure === "unreadable"
          ? vi.fn().mockRejectedValue(new Error("Read denied"))
          : vi.fn().mockResolvedValue(new Uint8Array([255]).buffer),
    });
    if (failure === "oversize")
      Object.defineProperty(file, "size", { value: 1_048_577 });
    fireEvent.change(screen.getByLabelText("Choose history CSV or TSV"), {
      target: { files: [file] },
    });
    await screen.findByText(
      failure === "oversize"
        ? "Choose a CSV or TSV up to 1 MiB."
        : "Export the history file as UTF-8 CSV or TSV before importing it.",
    );
    expect(screen.getByLabelText("Paste historical data")).toHaveValue("");
    expect(screen.getByLabelText("Source file label")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Save archive preview" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Save archive preview" }),
    );
    expect(state.operation).not.toHaveBeenCalled();
  },
);
it("requires exact saved review confirmation and invalidates approval when decisions change", async () => {
  await resume(reviewed());
  const approve = screen.getByRole("button", {
    name: "Approve archive-only review",
  });
  expect(approve).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(approve).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Review note for line 2"), {
    target: { value: "Changed decision context" },
  });
  expect(approve).toBeDisabled();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(
    screen.getByText("Save changed decisions before approving."),
  ).toBeVisible();
  expect(state.operation).toHaveBeenCalledTimes(1);
});
it("submits the exact reviewed fingerprint without inventing active accounting or record IDs", async () => {
  await resume(reviewed());
  state.operation.mockResolvedValueOnce(approved());
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Approve archive-only review" }),
  );
  await screen.findByText(/Immutable owner approval saved/);
  expect(state.operation).toHaveBeenLastCalledWith(
    "/legacy-history/imports/batch-a/approve",
    "POST",
    { revision: 2, reviewFingerprint: "f".repeat(64), confirmReadOnly: true },
  );
  expect(
    screen.getByRole("button", { name: "Save approved archive" }),
  ).toBeDisabled();
  expect(state.committed).not.toHaveBeenCalled();
});
it("keeps the same approved commit request after a lost response and never retries automatically", async () => {
  await resume(approved());
  state.operation.mockRejectedValueOnce(new Error("Response interrupted"));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Save approved archive" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Response interrupted",
  );
  expect(state.operation).toHaveBeenCalledTimes(2);
  state.operation.mockResolvedValueOnce({
    ...approved(),
    status: "committed",
    revision: 4,
    result: { archived: 1, skipped: 0, recordIds: ["archive-a"] },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save approved archive" }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Historical archive saved",
  );
  expect(state.operation.mock.calls[1]).toEqual(state.operation.mock.calls[2]);
  expect(state.operation.mock.calls[1]).toEqual([
    "/legacy-history/imports/batch-a/commit",
    "POST",
    {
      revision: 3,
      approvalId: "approval-a",
      approvalFingerprint: "f".repeat(64),
      confirmReadOnly: true,
    },
  ]);
  expect(state.committed).toHaveBeenCalledOnce();
});
it.each(["sales", "operations", "installer", "owner-preview"])(
  "does not expose historical source or import actions to %s",
  (role) => {
    state.user =
      role === "owner-preview"
        ? { role: "owner", previewRole: "owner" }
        : { role, previewRole: null };
    render(
      <LegacyArchiveImport onClose={vi.fn()} onCommitted={state.committed} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.queries).toEqual([]);
    expect(state.operation).not.toHaveBeenCalled();
  },
);
