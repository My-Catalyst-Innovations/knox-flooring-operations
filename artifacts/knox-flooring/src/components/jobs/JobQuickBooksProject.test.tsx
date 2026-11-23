import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JobQuickBooksProject } from "./JobQuickBooksProject";

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  operation: vi.fn(),
  refetch: vi.fn(),
  owner: true,
}));
vi.mock("@/lib/operations", () => ({
  operation: state.operation,
  useOperation: () => ({
    allowed: state.owner,
    data: state.data,
    refetch: state.refetch,
  }),
}));
const connection = {
  id: "connection-1",
  realmId: "realm-1",
  environment: "sandbox",
  companyName: "Verified company",
};
const review = {
  id: "review-1",
  jobId: "job-1",
  connectionId: "connection-1",
  revision: 3,
  fingerprint: "frozen-project",
  status: "pending_approval",
  name: "Verified project",
  description: "Actual installation",
  lastError: null,
  submittedAt: null,
  quickbooksProjectId: null,
};
beforeEach(() => {
  state.owner = true;
  state.operation.mockReset();
  state.refetch.mockReset().mockResolvedValue(undefined);
  state.data = {
    connection,
    capability: {
      connection,
      available: true,
      scopeGranted: true,
      preferenceEnabled: true,
      probeSucceeded: true,
      requestScopeEnabled: false,
    },
    job: { id: "job-1", jobNumber: "JOB-001", revision: 7, updatedAt: "now" },
    customer: { id: "customer-1", name: "Verified customer" },
    link: null,
    legacySubcustomer: { id: "legacy-1", name: "Old subcustomer" },
    review: null,
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("links only an explicitly selected customer-matched Project with owner note and current revisions", async () => {
  state.operation.mockResolvedValue({
    complete: true,
    projects: [
      {
        id: "project-1",
        name: "Existing Project",
        status: "IN_PROGRESS",
        customerId: "customer-1",
      },
    ],
  });
  render(<JobQuickBooksProject jobId="job-1" />);
  expect(
    screen.getByText(/This is separate from a QuickBooks Project/),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Load matching Projects" }),
  );
  fireEvent.change(
    await screen.findByRole("combobox", {
      name: "Existing QuickBooks Project",
    }),
    { target: { value: "project-1" } },
  );
  const link = screen.getByRole("button", {
    name: "Approve selected Project link",
  });
  expect(link).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Owner approval note"), {
    target: { value: "Verified with customer job scope" },
  });
  fireEvent.click(link);
  await waitFor(() =>
    expect(state.operation).toHaveBeenCalledWith(
      "/quickbooks/projects/jobs/job-1/link",
      "PUT",
      {
        connectionId: "connection-1",
        jobRevision: 7,
        projectId: "project-1",
        note: "Verified with customer job scope",
      },
    ),
  );
});
it("does not expose partial Project lists as selectable matches", async () => {
  state.operation.mockResolvedValue({
    complete: false,
    projects: [
      {
        id: "partial",
        name: "Incomplete",
        status: "IN_PROGRESS",
        customerId: "customer-1",
      },
    ],
  });
  render(<JobQuickBooksProject jobId="job-1" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Load matching Projects" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "complete Project list could not be verified",
  );
  expect(
    screen.queryByRole("combobox", { name: "Existing QuickBooks Project" }),
  ).not.toBeInTheDocument();
});
it("requires exact saved Project approval and submits its fingerprint once", async () => {
  state.data.review = review;
  render(<JobQuickBooksProject jobId="job-1" />);
  const submit = screen.getByRole("button", {
    name: "Approve and create Project",
  });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Owner approval note"), {
    target: { value: "Approved scoped installation" },
  });
  fireEvent.click(screen.getByLabelText(/I approve this exact new Project/));
  fireEvent.click(submit);
  await waitFor(() =>
    expect(state.operation).toHaveBeenCalledExactlyOnceWith(
      "/quickbooks/projects/reviews/review-1/submit",
      "POST",
      {
        connectionId: "connection-1",
        reviewRevision: 3,
        fingerprint: "frozen-project",
        note: "Approved scoped installation",
      },
    ),
  );
});
it("reconciles unknown creation without offering another create submission", async () => {
  state.data.review = { ...review, status: "unknown" };
  render(<JobQuickBooksProject jobId="job-1" />);
  expect(
    screen.queryByRole("button", { name: "Approve and create Project" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Prepare Project review" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Reconcile previous Project request" }),
  );
  await waitFor(() =>
    expect(state.operation).toHaveBeenCalledExactlyOnceWith(
      "/quickbooks/projects/reviews/review-1/reconcile",
      "POST",
      { connectionId: "connection-1", reviewRevision: 3 },
    ),
  );
});
it("keeps blocked company capability explanatory and hides owner controls from other roles", () => {
  state.data.capability = {
    ...(state.data.capability as object),
    available: false,
    reason: "Company plan has no Projects access",
  };
  const view = render(<JobQuickBooksProject jobId="job-1" />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Company plan has no Projects access",
  );
  expect(
    screen.queryByRole("button", { name: "Load matching Projects" }),
  ).not.toBeInTheDocument();
  view.unmount();
  state.owner = false;
  render(<JobQuickBooksProject jobId="job-1" />);
  expect(screen.queryByText("QuickBooks Project")).not.toBeInTheDocument();
});

it("requires fresh confirmation after a saved Project review changes", () => {
  state.data.review = review;
  const view = render(<JobQuickBooksProject jobId="job-1" />);
  fireEvent.change(screen.getByLabelText("Owner approval note"), {
    target: { value: "Reviewed" },
  });
  fireEvent.click(screen.getByLabelText(/I approve this exact new Project/));
  expect(
    screen.getByRole("button", { name: "Approve and create Project" }),
  ).toBeEnabled();
  state.data = {
    ...state.data,
    review: {
      ...review,
      revision: 4,
      fingerprint: "revised",
      name: "Revised Project",
    },
  };
  view.rerender(<JobQuickBooksProject jobId="job-1" />);
  expect(
    screen.getByRole("button", { name: "Approve and create Project" }),
  ).toBeDisabled();
});

it("allows explicit reapproval of a linked Project without offering another creation", () => {
  state.data.review = { ...review, status: "linked" };
  state.data.link = {
    kind: "qbo_project",
    projectId: "project-1",
    projectName: "Existing",
    projectStatus: "OPEN",
    revision: 2,
    customerId: "customer-1",
  };
  render(<JobQuickBooksProject jobId="job-1" />);
  expect(
    screen.getByRole("button", { name: "Load matching Projects" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Prepare Project review" }),
  ).not.toBeInTheDocument();
});

it("uses the OAuth route's authorizationUrl when requesting Projects permission", async () => {
  const authorizationUrl =
    "https://appcenter.intuit.com/connect/oauth2?scope=project-management.project";
  state.data.capability = {
    ...(state.data.capability as object),
    available: false,
    scopeGranted: false,
    requestScopeEnabled: true,
  };
  state.operation.mockResolvedValue({ authorizationUrl });
  const redirect = vi.fn();
  const actualWindow = window;
  vi.stubGlobal(
    "window",
    new Proxy(actualWindow, {
      get(target, property) {
        return property === "location"
          ? { assign: redirect }
          : Reflect.get(target, property, target);
      },
    }),
  );
  render(<JobQuickBooksProject jobId="job-1" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Enable Projects permission" }),
  );
  await waitFor(() =>
    expect(redirect).toHaveBeenCalledExactlyOnceWith(authorizationUrl),
  );
  expect(state.operation).toHaveBeenCalledExactlyOnceWith(
    "/quickbooks/connect?projects=true",
  );
});
