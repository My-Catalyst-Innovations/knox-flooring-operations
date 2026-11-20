import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Booking } from "@/lib/operations";
import type { Job, MaterialRecord } from "@/lib/types";
import Pipeline from "./pipeline";

const data = vi.hoisted(() => ({
  bookings: undefined as Booking[] | undefined,
  jobs: [] as Job[],
  materials: [] as MaterialRecord[],
  bookingError: false,
}));

vi.mock("@/contexts/auth", () => ({
  useAuth: () => ({ user: { role: "operations" } }),
}));
vi.mock("@/hooks/use-store", () => ({
  useStore: () => ({
    jobs: data.jobs,
    leads: [],
    proposals: [],
    invoices: [],
    materials: data.materials,
    queryState: { jobs: { isLoading: false, isError: false } },
  }),
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
    isError: path === "/bookings" && data.bookingError,
  }),
}));

const job = (id: string, status: Job["status"] = "Material Received") =>
  ({
    id,
    customerName: `${id} customer`,
    jobNumber: `J-${id}`,
    status,
    crewAssigned: "Unassigned",
  }) as Job;
const appointment = (
  jobId: string,
  status = "Confirmed",
  day = "2026-11-24",
): Booking => ({
  id: `${jobId}-booking`,
  jobId,
  crewId: "crew-1",
  status,
  startAt: `${day}T15:00:00Z`,
  endAt: `${day}T17:00:00Z`,
  notes: "",
  plannedLaborHours: 4,
  revision: 1,
});

beforeEach(() => {
  vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
  window.history.replaceState({}, "", "/pipeline");
  data.jobs = [
    job("booked"),
    job("blocked"),
    job("cancelled", "Scheduled"),
    job("previous"),
  ];
  data.bookings = [
    appointment("booked"),
    appointment("blocked"),
    appointment("cancelled", "Cancelled"),
    appointment("previous", "Confirmed", "2026-11-19"),
  ];
  data.materials = [
    {
      jobId: "blocked",
      damaged: true,
      missingItems: "",
      status: "Received",
    } as MaterialRecord,
  ];
  data.bookingError = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows confirmed installations with their actual booking and keeps blockers in preparation", () => {
  render(<Pipeline />);
  const installation = within(
    screen.getByRole("region", { name: "Installation" }),
  );
  const bookedCard = within(
    installation
      .getByRole("link", { name: "booked customer" })
      .closest("article")!,
  );
  expect(bookedCard.getByText("Material Received")).toBeVisible();
  expect(bookedCard.getByText("Review work order")).toBeVisible();
  expect(
    bookedCard.getByText(/Confirmed.*Oak Installation Crew/),
  ).toBeVisible();
  expect(
    bookedCard.getByRole("link", { name: "View booking" }),
  ).toHaveAttribute("href", "/calendar?booking=booked-booking&date=2026-11-24");
  expect(
    bookedCard.queryByRole("link", { name: "Schedule" }),
  ).not.toBeInTheDocument();

  const preparation = within(
    screen.getByRole("region", { name: "Preparation" }),
  );
  expect(
    preparation.getByRole("link", { name: "blocked customer" }),
  ).toBeVisible();
  expect(preparation.getByText("Damaged materials")).toBeVisible();
  expect(preparation.getByText("Review the previous booking")).toBeVisible();
  const cancelledCard = within(
    installation
      .getByRole("link", { name: "cancelled customer" })
      .closest("article")!,
  );
  expect(cancelledCard.getByText("Rebook the installation")).toBeVisible();
  expect(cancelledCard.getByRole("link", { name: "Schedule" })).toHaveAttribute(
    "href",
    "/calendar?create=1&jobId=cancelled",
  );
});

it("does not offer an installation action based on unverified or failed booking reads", () => {
  const savedBookings = data.bookings;
  data.bookings = undefined;
  const { rerender } = render(<Pipeline />);
  expect(screen.getByText("Loading booking status…")).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Schedule" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Book the installation")).not.toBeInTheDocument();

  data.bookings = savedBookings;
  data.bookingError = true;
  rerender(<Pipeline />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Booking status could not load.",
  );
  expect(
    screen.queryByRole("link", { name: "View booking" }),
  ).not.toBeInTheDocument();
});
