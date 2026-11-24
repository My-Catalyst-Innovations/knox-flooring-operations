import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JobMigrationCutover } from "./JobMigrationCutover";
import {
  billingReview,
  cutoverState,
  importedJob,
} from "@/test/active-job-fixtures";
import type { JobCutoverState } from "@/lib/active-job-import";
const state = vi.hoisted(() => ({
  user: { role: "owner", previewRole: null } as any,
  query: null as JobCutoverState | null,
  request: vi.fn(),
  refetch: vi.fn(),
  refresh: vi.fn(),
  reads: [] as string[],
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/operations", () => ({
  operation: state.request,
  useRefreshOperations: () => state.refresh,
  useOperation: (path: string) => {
    state.reads.push(path);
    return {
      data: state.query,
      refetch: state.refetch,
      isLoading: false,
      isError: false,
    };
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.request.mockReset();
  state.user = { role: "owner", previewRole: null };
  state.query = structuredClone(cutoverState);
  state.reads = [];
});
afterEach(cleanup);
it.each([
  { role: "operations" },
  { role: "sales" },
])(
  "shows a read-only unknown summary without owner queries or mutations: %j",
  (user) => {
    state.user = user;
    render(<JobMigrationCutover job={structuredClone(importedJob)} />);
    expect(state.reads).toEqual([]);
    expect(state.request).not.toHaveBeenCalled();
    expect(screen.getByText("Unreconciled · excluded")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save evidence review" }),
    ).toBeNull();
  },
);
it.each([null, { role: "installer" }, { role: "owner", previewRole: "installer" }])("never renders office financial context in installer or unauthenticated mode: %j", (user) => {
  state.user = user; render(<JobMigrationCutover job={structuredClone(importedJob)} />);
  expect(state.reads).toEqual([]); expect(state.request).not.toHaveBeenCalled(); expect(screen.queryByText("Imported job · cutover review")).toBeNull();
});
it("opening an owner review performs no business action and displays source vs Works stage separately", () => {
  render(<JobMigrationCutover job={structuredClone(importedJob)} />);
  expect(state.reads).toContain("/jobs/job-1/cutover");
  expect(state.request).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      /original stage Scheduled\. Current Works stage: Approved/,
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/zero ceiling does not mean this job is paid/),
  ).toBeInTheDocument();
});
it("requires explicit full-job figures and evidence, preserving exact cents and reviewed zero", async () => {
  state.request.mockResolvedValue({
    ...billingReview,
    kind: "financial_context",
  });
  render(<JobMigrationCutover job={structuredClone(importedJob)} />);
  fireEvent.change(screen.getByLabelText("Cutover review type"), {
    target: { value: "financial_context" },
  });
  expect(screen.getByLabelText("Full-job forecast revenue ($)")).toHaveValue(
    "",
  );
  for (const [label, value] of [
    ["Full-job forecast revenue ($)", "4.46"],
    ["Full-job forecast labor ($)", "0"],
    ["Full-job forecast materials ($)", "1.23"],
    ["Full-job forecast other costs ($)", "0"],
    ["Cutover review note", "Reviewed the complete job estimate basis"],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Evidence Original review evidence.pdf",
    }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: /These are full-job forecast/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save evidence review" }));
  await waitFor(() =>
    expect(state.request).toHaveBeenCalledExactlyOnceWith(
      "/jobs/job-1/cutover/reviews",
      "POST",
      {
        jobRevision: 1,
        cutoverRevision: 1,
        payload: {
          kind: "financial_context",
          fullJobRevenueCents: 446,
          fullJobLaborForecastCents: 0,
          fullJobMaterialForecastCents: 123,
          fullJobOtherForecastCents: 0,
          evidenceDocumentIds: ["document-1"],
          note: "Reviewed the complete job estimate basis",
          confirmForecastOnly: true,
        },
      },
    ),
  );
});
it("requires a separate exact saved-payload confirmation and invalidates stale reviews", async () => {
  state.query!.reviews = [structuredClone(billingReview)];
  const { rerender } = render(
    <JobMigrationCutover job={structuredClone(importedJob)} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Remaining billing permission ·/ }),
  );
  const approve = screen.getByRole("button", { name: "Approve frozen review" });
  expect(approve).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I verified actual operational readiness/,
    }),
  );
  expect(approve).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I reviewed this exact saved payload/,
    }),
  );
  expect(approve).toBeEnabled();
  state.query = { ...state.query!, scopeFingerprint: "new-scope" };
  rerender(<JobMigrationCutover job={structuredClone(importedJob)} />);
  expect(approve).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("review is stale");
  expect(state.request).not.toHaveBeenCalled();
});
it("does not apply a saved review until its immutable approval receives a new confirmation", async () => {
  state.query!.reviews = [structuredClone(billingReview)];
  state.request.mockResolvedValueOnce({
    ...billingReview,
    approval: {
      id: "approval-1",
      approvedBy: "owner-1",
      approvedAt: "2026-11-23T19:00:00Z",
    },
  });
  render(<JobMigrationCutover job={structuredClone(importedJob)} />);
  fireEvent.click(
    screen.getByRole("button", { name: /Remaining billing permission ·/ }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I reviewed this exact saved payload/,
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Approve frozen review" }),
  );
  const apply = await screen.findByRole("button", {
    name: "Apply approved cutover",
  });
  expect(apply).toBeDisabled();
  expect(state.request).toHaveBeenCalledExactlyOnceWith(
    "/jobs/job-1/cutover/reviews/review-1/approve",
    "POST",
    { fingerprint: billingReview.fingerprint },
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I reviewed this exact saved payload/,
    }),
  );
  state.request.mockResolvedValueOnce({
    ...billingReview,
    commit: {
      id: "commit-1",
      committedBy: "owner-1",
      committedAt: "2026-11-23T19:01:00Z",
    },
  });
  fireEvent.click(apply);
  await waitFor(() =>
    expect(state.request).toHaveBeenLastCalledWith(
      "/jobs/job-1/cutover/reviews/review-1/commit",
      "POST",
      { approvalId: "approval-1", fingerprint: billingReview.fingerprint },
    ),
  );
});
