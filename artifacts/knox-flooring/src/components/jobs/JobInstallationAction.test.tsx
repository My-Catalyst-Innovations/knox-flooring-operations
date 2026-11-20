import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking } from "@/lib/operations";
import type { Job } from "@/lib/types";
import { JobInstallationAction } from "./JobInstallationAction";

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), role: "operations" }));
vi.mock("@/contexts/auth", () => ({
  useAuth: () => ({ user: { id: "staff", role: fixture.role } }),
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  customFetch: fixture.fetch,
}));

const job = {
  id: "job/ready+1",
  status: "Material Received",
  estStartDate: "2026-11-30",
} as Job;
const path = "/bookings?jobId=job%2Fready%2B1";

const booking = (
  id: string,
  day: string,
  status = "Confirmed",
  jobId = job.id,
): Booking => ({
  id,
  jobId,
  crewId: "crew-1",
  status,
  startAt: `${day}T14:00:00Z`,
  endAt: `${day}T16:00:00Z`,
  notes: "",
  plannedLaborHours: 4,
  revision: 1,
});

function renderAction(props = job) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <JobInstallationAction job={props} />
    </QueryClientProvider>,
  );
  return () =>
    client.getQueryState(["operations", "staff", fixture.role, path])?.status;
}

beforeEach(() => {
  fixture.role = "operations";
  fixture.fetch.mockReset();
  vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("job detail installation action", () => {
  it("opens the existing create route with this job and date after a cancelled booking", async () => {
    fixture.fetch.mockResolvedValue([
      booking("cancelled", "2026-11-24", "Cancelled"),
    ]);
    renderAction();

    expect(
      await screen.findByRole("link", { name: "Schedule installation" }),
    ).toHaveAttribute(
      "href",
      "/calendar?create=1&date=2026-11-30&jobId=job%2Fready%2B1",
    );
    expect(fixture.fetch).toHaveBeenCalledExactlyOnceWith(
      `/api${path}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("offers the next confirmed booking instead of creating a second one", async () => {
    fixture.fetch.mockResolvedValue([
      booking("another-job", "2026-11-21", "Confirmed", "other"),
      booking("later", "2026-11-27"),
      booking("older", "2026-11-19"),
      booking("next", "2026-11-23"),
    ]);
    renderAction();

    expect(
      await screen.findByRole("link", { name: "View installation booking" }),
    ).toHaveAttribute("href", "/calendar?booking=next&date=2026-11-23");
    expect(
      screen.queryByRole("link", { name: "Schedule installation" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer a new booking for a completed job or after a failed booking check", async () => {
    fixture.fetch.mockResolvedValueOnce([]);
    const status = renderAction({ ...job, status: "Completed" });
    await waitFor(() => expect(status()).toBe("success"));
    expect(
      screen.queryByRole("link", { name: "Schedule installation" }),
    ).not.toBeInTheDocument();
    cleanup();

    fixture.fetch.mockRejectedValueOnce(new Error("Bookings unavailable"));
    const failure = renderAction();
    await waitFor(() => expect(failure()).toBe("error"));
    expect(
      screen.queryByRole("link", { name: "Schedule installation" }),
    ).not.toBeInTheDocument();
  });

  it("does not fetch crew bookings for an installer", async () => {
    fixture.role = "installer";
    renderAction();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
});
