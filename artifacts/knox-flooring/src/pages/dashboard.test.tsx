import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Dashboard from "./dashboard";
import type { Booking } from "@/lib/operations";
import type { Job } from "@/lib/types";

const data = vi.hoisted(() => ({
  role: "operations",
  jobs: [] as Job[],
  bookings: undefined as Booking[] | undefined,
  bookingsError: false,
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
    data:
      path === "/bookings"
        ? data.bookings
        : path === "/crews"
          ? [{ id: "crew-1", name: "Oak Installation Crew" }]
          : undefined,
    isError: path === "/bookings" && data.bookingsError,
  }),
}));

const job = (id: string, status: Job["status"], estStartDate?: string): Job =>
  ({
    id,
    jobNumber: `J-${id}`,
    customerName: `Customer ${id}`,
    status,
    estStartDate,
    crewAssigned: "Unassigned",
  }) as Job;

beforeEach(() => {
  vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
  data.role = "operations";
  data.bookingsError = false;
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
  ].map((booking) => ({
    ...booking,
    id: `${booking.jobId}-booking`,
    crewId: "crew-1",
    startAt: "2026-11-24T15:00:00Z",
    endAt: "2026-11-24T17:00:00Z",
    notes: "",
    revision: 1,
    plannedLaborHours: 4,
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

it("shows the actual assigned crew and booking link without promoting a cancelled booking", () => {
  render(<Dashboard />);

  expect(screen.getByText("J-booked · Oak Installation Crew")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open booking for J-booked" }),
  ).toHaveAttribute("href", "/calendar?booking=booked-booking&date=2026-11-24");
  expect(
    screen.queryByRole("link", { name: "Open booking for J-cancelled" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("J-booked · Unassigned")).not.toBeInTheDocument();
});

it("keeps upcoming and unbooked status unknown while booking data loads or fails", () => {
  const savedBookings = data.bookings;
  data.bookings = undefined;
  const { rerender } = render(<Dashboard />);
  expect(screen.getByText("Loading upcoming installations…")).toBeVisible();
  expect(
    screen.queryByText("No confirmed installations in the next seven days"),
  ).not.toBeInTheDocument();

  data.bookings = savedBookings;
  data.bookingsError = true;
  rerender(<Dashboard />);
  expect(
    screen.getByText("Could not load upcoming installations."),
  ).toBeVisible();
  expect(
    screen.queryByText("J-booked · Oak Installation Crew"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: /^Schedule J-/ }),
  ).not.toBeInTheDocument();
});
