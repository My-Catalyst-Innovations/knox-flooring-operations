import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ActiveJobImports from "./active-job-imports";
import { activeBatch, activeChoices } from "@/test/active-job-fixtures";
const state = vi.hoisted(() => ({
  user: { role: "owner", previewRole: null } as any,
  request: vi.fn(),
  refetch: vi.fn(),
  refresh: vi.fn(),
  queries: [] as string[],
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/operations", () => ({
  operation: state.request,
  useRefreshOperations: () => state.refresh,
  useOperation: (path: string) => {
    state.queries.push(path);
    return {
      data: path === "/active-job-imports" ? [activeBatch] : activeChoices,
      refetch: state.refetch,
      isError: false,
    };
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.request.mockReset();
  state.user = { role: "owner", previewRole: null };
  state.queries = [];
});
afterEach(cleanup);
it("keeps immutable approval and commit as separately confirmed steps", async () => {
  const reviewed = {
    ...structuredClone(activeBatch),
    status: "reviewed" as const,
    revision: 2,
    reviewFingerprint: "f".repeat(64),
    reviewNote: "Reviewed source row",
    decisions: [
      { line: 2, action: "skip" as const, note: "Archived elsewhere" },
    ],
  };
  state.request.mockResolvedValueOnce(reviewed);
  render(<ActiveJobImports />);
  fireEvent.click(
    screen.getByRole("button", { name: /legacy-test · cutover-one/ }),
  );
  const approve = await screen.findByRole("button", {
    name: "Approve saved review",
  });
  expect(approve).toBeDisabled();
  expect(state.request).toHaveBeenCalledTimes(1);
  const approved = {
    ...reviewed,
    status: "approved" as const,
    revision: 3,
    approval: {
      id: "approval-1",
      fingerprint: "f".repeat(64),
      approvedBy: "owner-1",
      approvedAt: "2026-11-23T19:00:00Z",
    },
  };
  state.request.mockResolvedValueOnce(approved);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(approve);
  const commit = await screen.findByRole("button", {
    name: "Commit approved operational records",
  });
  expect(commit).toBeDisabled();
  expect(state.request).toHaveBeenLastCalledWith(
    "/active-job-imports/batch-1/approve",
    "POST",
    {
      revision: 2,
      reviewFingerprint: "f".repeat(64),
      confirmNoFinancialOrOperationalSideEffects: true,
    },
  );
  state.request.mockResolvedValueOnce({
    ...approved,
    status: "committed",
    revision: 4,
    result: { created: 0, linked: 0, skipped: 1, jobIds: [] },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(commit);
  await waitFor(() =>
    expect(state.request).toHaveBeenLastCalledWith(
      "/active-job-imports/batch-1/commit",
      "POST",
      {
        revision: 3,
        approvalId: "approval-1",
        approvalFingerprint: "f".repeat(64),
        confirmNoFinancialOrOperationalSideEffects: true,
      },
    ),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "0 created · 0 linked unchanged · 1 skipped",
  );
});
it.each([
  null,
  { role: "sales" },
  { role: "operations" },
  { role: "installer" },
  { role: "owner", previewRole: "installer" },
])("does not query or mutate imports outside actual owner mode: %j", (user) => {
  state.user = user;
  render(<ActiveJobImports />);
  expect(state.queries).toEqual([]);
  expect(state.request).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Save source preview" }),
  ).toBeNull();
});
it("saves only explicitly pasted source with leading zeros and no financial or operational action", async () => {
  state.request.mockResolvedValueOnce(structuredClone(activeBatch));
  render(<ActiveJobImports />);
  const source = "\uFEFFsource_id,source_status\n00007,Scheduled\n";
  fireEvent.change(screen.getByLabelText("Source system"), {
    target: { value: "legacy-test" },
  });
  fireEvent.change(screen.getByLabelText("Source batch key"), {
    target: { value: "cutover-one" },
  });
  fireEvent.change(screen.getByLabelText("Source CSV or TSV"), {
    target: { value: source },
  });
  expect(state.request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save source preview" }));
  await waitFor(() =>
    expect(state.request).toHaveBeenCalledExactlyOnceWith(
      "/active-job-imports/preview",
      "POST",
      {
        sourceSystem: "legacy-test",
        batchKey: "cutover-one",
        fileName: "Pasted active jobs.csv",
        csv: source,
        delimiter: ",",
      },
    ),
  );
  expect(
    await screen.findByText("Source job: OLD-0003 · Original stage: Scheduled"),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Decision line 2")).toHaveValue("");
});
it("clears a previous source when the next selected file is unreadable", async () => {
  render(<ActiveJobImports />);
  fireEvent.change(screen.getByLabelText("Source system"), {
    target: { value: "legacy-test" },
  });
  fireEvent.change(screen.getByLabelText("Source batch key"), {
    target: { value: "one" },
  });
  fireEvent.change(screen.getByLabelText("Source CSV or TSV"), {
    target: { value: "source_id,source_status\n00007,Approved" },
  });
  fireEvent.change(screen.getByLabelText("Choose active-job source file"), {
    target: {
      files: [
        {
          name: "bad.csv",
          size: 4,
          arrayBuffer: async () => {
            throw new Error("unreadable");
          },
        },
      ],
    },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("readable UTF-8");
  expect(screen.getByLabelText("Source CSV or TSV")).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "Save source preview" }),
  ).toBeDisabled();
  expect(state.request).not.toHaveBeenCalled();
});
it("requires explicit identity, supported entry-stage mapping and date decisions, then invalidates an edited review", async () => {
  state.request.mockResolvedValueOnce(structuredClone(activeBatch));
  render(<ActiveJobImports />);
  fireEvent.click(
    screen.getByRole("button", { name: /legacy-test · cutover-one/ }),
  );
  await screen.findByLabelText("Decision line 2");
  fireEvent.change(screen.getByLabelText("Decision line 2"), {
    target: { value: "create" },
  });
  expect(screen.queryByRole("option", { name: "Scheduled" })).toBeNull();
  for (const [label, value] of [
    ["Customer line 2", "customer-1"],
    ["Site line 2", "none"],
    ["Works entry stage line 2", "Approved"],
    ["Stage mapping reason line 2", "No actual booking has been verified"],
    ["Flooring type line 2", "Carpet"],
    ["Source dates line 2", "false"],
    ["Decision note line 2", "Verified the exact existing customer"],
    ["Batch review note", "Reviewed original source without balances"],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const decisions = [
    {
      line: 2,
      action: "create",
      customerId: "customer-1",
      customerRevision: 2,
      siteId: null,
      siteFingerprint: null,
      entryStage: "Approved",
      flooringType: "Carpet",
      stageMappingReason: "No actual booking has been verified",
      acceptSourceDates: false,
      note: "Verified the exact existing customer",
    },
  ];
  state.request.mockResolvedValueOnce({
    ...structuredClone(activeBatch),
    status: "reviewed",
    revision: 2,
    decisions,
    reviewNote: "Reviewed original source without balances",
    reviewFingerprint: "f".repeat(64),
  });
  fireEvent.click(screen.getByRole("button", { name: "Save exact review" }));
  await waitFor(() =>
    expect(state.request).toHaveBeenLastCalledWith(
      "/active-job-imports/batch-1/review",
      "POST",
      expect.objectContaining({ decisions }),
    ),
  );
  const approve = await screen.findByRole("button", {
    name: "Approve saved review",
  });
  expect(approve).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(approve).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Decision note line 2"), {
    target: { value: "A changed identity review needs saving" },
  });
  expect(approve).toBeDisabled();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(state.request).toHaveBeenCalledTimes(2);
});
