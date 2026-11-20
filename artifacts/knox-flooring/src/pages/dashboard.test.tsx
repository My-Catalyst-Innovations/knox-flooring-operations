import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Dashboard from "./dashboard";
import type { Job } from "@/lib/types";

const data = vi.hoisted(() => ({
  role: "operations",
  jobs: [] as Job[],
  bookings: [] as { jobId: string; status: string }[],
}));

vi.mock("@/contexts/auth", () => ({
  useAuth: () => ({ user: { role: data.role } }),
}));
vi.mock("@/hooks/use-store", () => ({
  useStore: () => ({
    jobs: data.jobs,
    leads: [],
    materials: [],
    proposals: [],
    invoices: [],
    queryState: { jobs: { isLoading: false }, leads: { isLoading: false } },
  }),
  useTasks: () => ({ tasks: [], isLoading: false }),
}));
vi.mock("@/lib/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations")>()),
  useOperation: (path: string) => ({
    data: path === "/bookings" ? data.bookings : undefined,
  }),
}));

const job = (id: string, status: Job["status"], estStartDate?: string): Job =>
  ({
    id,
    jobNumber: `J-${id}`,
    customerName: `Customer ${id}`,
    status,
    estStartDate,
  }) as Job;

beforeEach(() => {
  data.role = "operations";
  data.jobs = [
    job("ready", "Approved"),
    job("cancelled", "Material Ordered", "2026-11-25"),
    job("booked", "Material Received"),
    job("quote", "Proposal Sent"),
    job("closed", "Invoiced"),
  ];
  data.bookings = [
    { jobId: "cancelled", status: "Cancelled" },
    { jobId: "booked", status: "Confirmed" },
  ];
});
afterEach(cleanup);

it("opens scheduling for approved jobs still waiting on a crew booking", () => {
  render(<Dashboard />);

  expect(
    screen.getByRole("link", { name: "Schedule J-ready for Customer ready" }),
  ).toHaveAttribute("href", "/calendar?create=1&jobId=ready");
  expect(
    screen.getByRole("link", {
      name: "Schedule J-cancelled for Customer cancelled",
    }),
  ).toHaveAttribute(
    "href",
    "/calendar?create=1&date=2026-11-25&jobId=cancelled",
  );
  expect(screen.getAllByRole("link", { name: /^Schedule J-/ })).toHaveLength(2);
});

it("keeps scheduling shortcuts out of the sales dashboard", () => {
  data.role = "sales";
  render(<Dashboard />);

  expect(screen.queryByText("Needs scheduling")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: /^Schedule J-/ }),
  ).not.toBeInTheDocument();
});
