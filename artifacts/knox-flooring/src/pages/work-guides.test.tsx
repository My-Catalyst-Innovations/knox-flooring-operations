import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import WorkGuides from "./work-guides";
import WorkOrder from "./work-order";
import type { WorkGuide } from "@/lib/work-guides";

const mocks = vi.hoisted(() => ({
  role: "installer",
  operation: vi.fn(),
  refetch: vi.fn(),
  updateQuery: vi.fn(),
  calls: [] as string[],
  detailError: false,
  selectedJob: "job-a",
  data: null as WorkGuide | null,
}));
vi.mock("@/contexts/auth", () => ({
  useAuth: () => ({
    user: { id: "installer-a", name: "Installer A", role: mocks.role },
    logout: vi.fn(),
  }),
}));
vi.mock("wouter", () => ({
  useParams: () => ({ id: "job-a" }),
  Link: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: (key: string) =>
    useState(key === "job" ? mocks.selectedJob : ""),
  useQueryControls: () => ({ update: mocks.updateQuery }),
}));
vi.mock("@/lib/operations", () => ({
  operation: mocks.operation,
  quantity: (value: number) => String(value),
  useOperation: (path: string, roles?: string[]) => {
    mocks.calls.push(path);
    const allowed = !roles || roles.includes(mocks.role);
    if (path.startsWith("/work-guides/jobs?") || path === "/work-guides/jobs")
      return {
        allowed,
        data: allowed
          ? {
              jobs: [
                {
                  id: "job-a",
                  jobNumber: "J-001",
                  customerName: "Assigned customer",
                  status: "In Progress",
                },
                {
                  id: "job-b",
                  jobNumber: "J-002",
                  customerName: "Other accessible job",
                  status: "Scheduled",
                },
              ],
              hasMore: false,
            }
          : undefined,
        refetch: mocks.refetch,
      };
    return {
      allowed,
      data: allowed ? mocks.data : undefined,
      refetch: mocks.refetch,
      isError: mocks.detailError,
      isFetching: false,
    };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "installer";
  mocks.calls = [];
  mocks.detailError = false;
  mocks.selectedJob = "job-a";
  mocks.data = {
    job: {
      id: "job-a",
      jobNumber: "J-001",
      customerName: "Assigned customer",
      status: "In Progress",
      address: "100 Field Way",
      city: "Knoxville",
      flooringType: "Tile",
      scopeOfWork: "Install assigned room",
      rooms: [],
    },
    tasks: [
      {
        id: "task-a",
        title: "Assigned install",
        startAt: "2026-11-23T14:00:00Z",
        endAt: "2026-11-23T16:00:00Z",
        status: "Open",
        bookingId: null,
      },
    ],
    bookings: [],
    materials: [{ id: "material-a", name: "Tile", quantity: 10, unit: "sqft" }],
    installation: [
      {
        key: "update",
        title: "Save a field update",
        instruction: "Save actual work.",
        verified: false,
        evidence: "No saved update.",
      },
    ],
    warehouse: null,
    orders: [],
    selectedOrderId: null,
    ownUpdates: [],
    checkedAt: "2026-11-23T17:00:00Z",
  };
});
afterEach(cleanup);

it("opens only scoped real-work APIs and cannot mark evidence complete by clicking through", () => {
  render(<WorkGuides />);
  expect(screen.getByText(/Awaiting saved evidence/)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /complete|done/i }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Warehouse purchase order"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Back to workspace" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh saved evidence" }),
  );
  expect(mocks.refetch).toHaveBeenCalledOnce();
  expect(mocks.operation).not.toHaveBeenCalled();
  expect(
    mocks.calls.every((path) => path.startsWith("/work-guides/jobs")),
  ).toBe(true);
  expect(screen.getByRole("link", { name: "Open work order" })).toHaveAttribute(
    "href",
    "/jobs/job-a/work-order",
  );
});
it("saves a real update only on explicit submit and reuses its ID after a lost response", async () => {
  mocks.operation
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockResolvedValueOnce({});
  render(<WorkGuides />);
  const input = screen.getByLabelText("Work performed, issue or handoff");
  fireEvent.change(input, {
    target: { value: "Finished room; trim needs review" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save job update" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Response lost");
  expect(input).toHaveValue("Finished room; trim needs review");
  fireEvent.click(screen.getByRole("button", { name: "Save job update" }));
  expect(
    await screen.findByText("Your job update was saved for the team."),
  ).toBeVisible();
  expect(mocks.operation).toHaveBeenCalledTimes(2);
  expect(mocks.operation.mock.calls[0]).toEqual(mocks.operation.mock.calls[1]);
  expect(mocks.operation.mock.calls[0]).toEqual([
    "/work-guides/jobs/job-a/updates",
    "POST",
    { id: expect.any(String), message: "Finished room; trim needs review" },
  ]);
  expect(mocks.refetch).toHaveBeenCalledOnce();
  // A successful save does not invent a completed outcome before the server rechecks.
  expect(screen.getByText(/Awaiting saved evidence/)).toBeVisible();
});
it("clears the previous purchase-order selection atomically when changing jobs", () => {
  mocks.role = "operations";
  render(<WorkGuides />);
  fireEvent.change(screen.getByLabelText("Job"), {
    target: { value: "job-b" },
  });
  expect(mocks.updateQuery).toHaveBeenCalledWith({ job: "job-b", order: null });
});
it("hides stale detail and actions after access recheck fails", () => {
  mocks.detailError = true;
  render(<WorkGuides />);
  expect(screen.getByRole("alert")).toHaveTextContent("no longer accessible");
  expect(screen.queryByText("Install assigned room")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save job update" }),
  ).not.toBeInTheDocument();
});
it("prints only the safe work-order DTO and keeps installers in the authorized guide", () => {
  render(<WorkOrder />);
  expect(screen.getByText("Install assigned room")).toBeVisible();
  expect(screen.getByText("Assigned install", { exact: false })).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Back to work guide" }),
  ).toHaveAttribute("href", "/work-guides?job=job-a");
  expect(mocks.calls).toEqual(["/work-guides/jobs/job-a/work-order"]);
  expect(screen.queryByText(/cost|price|revenue/i)).not.toBeInTheDocument();
});
