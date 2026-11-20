import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking, Crew } from "@/lib/operations";
import type { Job } from "@/lib/types";
import { InstallationSchedule } from "./InstallationSchedule";

const mocks = vi.hoisted(() => ({
  operation: vi.fn(),
  refresh: vi.fn(),
  jobs: [] as Pick<Job, "id" | "jobNumber" | "customerName" | "status">[],
  jobsLoading: false,
  bookings: [] as Booking[],
  crews: [] as Crew[],
}));

vi.mock("@/hooks/use-store", () => ({
  useStore: () => ({
    jobs: mocks.jobs,
    queryState: { jobs: { isLoading: mocks.jobsLoading, error: null } },
  }),
}));

vi.mock("@/lib/operations", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/operations")>();
  return {
    ...original,
    operation: mocks.operation,
    useOperation: (path: string) => ({
      data: path === "/crews" ? mocks.crews : mocks.bookings,
      allowed: true,
      isLoading: false,
      isError: false,
    }),
    useRefreshOperations: () => mocks.refresh,
  };
});

const job = {
  id: "job-1",
  jobNumber: "KNOX-100",
  customerName: "Sample customer",
  status: "Approved" as const,
};

const crew: Crew = {
  id: "crew-1",
  name: "Installation crew",
  active: true,
  timezone: "America/New_York",
  size: 2,
  dailyCapacityHours: 8,
  workingDays: [1, 2, 3, 4, 5],
  unavailableDates: [],
  revision: 1,
};

beforeEach(() => {
  mocks.operation.mockReset();
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.jobs = [job];
  mocks.crews = [crew];
  mocks.bookings = [];
  mocks.jobsLoading = false;
});

afterEach(cleanup);

describe("installation booking links", () => {
  it("opens a booking for a job dropped on a calendar day without saving it", async () => {
    window.history.replaceState(
      {},
      "",
      `/calendar?date=2026-11-24&crew=${crew.id}`,
    );
    render(<InstallationSchedule />);

    const jobs = within(
      screen.getByRole("complementary", { name: "Needs scheduling" }),
    );
    const card = jobs.getByRole("listitem");
    const day = screen.getByRole("region", { name: /Nov 25/ });
    const payload = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => payload.set(type, value),
      getData: (type: string) => payload.get(type) ?? "",
    };

    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(day, { dataTransfer });
    fireEvent.drop(day, { dataTransfer });

    const dialog = within(
      await screen.findByRole("dialog", { name: "Book installation" }),
    );
    expect(dialog.getByLabelText("Job")).toHaveValue(job.id);
    expect(dialog.getByLabelText("Crew")).toHaveValue(crew.id);
    expect(dialog.getByLabelText("Start")).toHaveValue("2026-11-25T08:00");
    expect(dialog.getByLabelText("End")).toHaveValue("2026-11-25T09:00");
    expect(mocks.operation).not.toHaveBeenCalled();
  });

  it("waits for job data, prefills the selected job, and closes without a write", async () => {
    window.history.replaceState(
      {},
      "",
      "/calendar?create=1&jobId=job-1&date=2026-11-24",
    );
    mocks.jobs = [];
    mocks.jobsLoading = true;
    const { rerender } = render(<InstallationSchedule />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    mocks.jobs = [job];
    mocks.jobsLoading = false;
    rerender(<InstallationSchedule />);
    const dialog = await screen.findByRole("dialog", {
      name: "Book installation",
    });
    expect(within(dialog).getByLabelText("Job")).toHaveValue(job.id);
    expect(mocks.operation).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    rerender(<InstallationSchedule />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const params = new URLSearchParams(window.location.search);
    expect(params.has("create")).toBe(false);
    expect(params.has("jobId")).toBe(false);
    expect(params.get("date")).toBe("2026-11-24");
    expect(mocks.operation).not.toHaveBeenCalled();
  });

  it("keeps the prefilled job and entered values when a save fails and can retry", async () => {
    window.history.replaceState(
      {},
      "",
      "/calendar?create=1&jobId=job-1&date=2026-11-24",
    );
    mocks.operation
      .mockRejectedValueOnce(
        new Error("This crew already has an overlapping booking."),
      )
      .mockResolvedValueOnce({});
    render(<InstallationSchedule />);

    const dialog = within(
      await screen.findByRole("dialog", { name: "Book installation" }),
    );
    fireEvent.change(dialog.getByLabelText("Crew"), {
      target: { value: crew.id },
    });
    fireEvent.change(dialog.getByLabelText(/Planned person-hours/), {
      target: { value: "2" },
    });
    fireEvent.change(dialog.getByLabelText("Notes"), {
      target: { value: "Confirm access with dispatch" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save booking" }));

    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "overlapping booking",
    );
    expect(dialog.getByLabelText("Job")).toHaveValue(job.id);
    expect(dialog.getByLabelText("Crew")).toHaveValue(crew.id);
    expect(dialog.getByLabelText(/Planned person-hours/)).toHaveValue(2);
    expect(dialog.getByLabelText("Notes")).toHaveValue(
      "Confirm access with dispatch",
    );

    fireEvent.click(dialog.getByRole("button", { name: "Save booking" }));
    expect(
      await screen.findByText("Installation booking saved."),
    ).toBeVisible();
    expect(mocks.operation).toHaveBeenCalledTimes(2);
    expect(mocks.operation).toHaveBeenLastCalledWith(
      "/bookings",
      "POST",
      expect.objectContaining({
        jobId: job.id,
        crewId: crew.id,
        plannedLaborHours: 2,
      }),
    );
  });

  it("keeps existing booking links in edit mode with revision checking", async () => {
    window.history.replaceState({}, "", "/calendar?booking=booking-1");
    mocks.bookings = [
      {
        id: "booking-1",
        jobId: job.id,
        crewId: crew.id,
        startAt: "2026-11-24T13:00:00.000Z",
        endAt: "2026-11-24T15:00:00.000Z",
        plannedLaborHours: 4,
        status: "Confirmed",
        notes: "Original notes",
        revision: 3,
      },
    ];
    mocks.operation.mockResolvedValueOnce({});
    render(<InstallationSchedule />);

    const dialog = within(
      await screen.findByRole("dialog", { name: "Edit installation" }),
    );
    expect(dialog.getByLabelText("Job")).toHaveValue(job.id);
    expect(dialog.getByLabelText("Notes")).toHaveValue("Original notes");
    expect(mocks.operation).not.toHaveBeenCalled();
    fireEvent.change(dialog.getByLabelText("Notes"), {
      target: { value: "New notes" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save booking" }));

    await waitFor(() =>
      expect(mocks.operation).toHaveBeenCalledWith(
        "/bookings/booking-1",
        "PATCH",
        expect.objectContaining({ revision: 3, notes: "New notes" }),
      ),
    );
    expect(
      await screen.findByText("Installation booking saved."),
    ).toBeVisible();
  });
});
