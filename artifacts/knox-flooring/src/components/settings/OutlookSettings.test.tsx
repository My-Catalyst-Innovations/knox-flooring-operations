import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutlookSettings } from "./OutlookSettings";

const fixture = vi.hoisted(() => ({
  operation: vi.fn(),
  refetch: vi.fn(),
  allowed: true,
  status: {
    configured: true,
    status: "connected",
    accountName: "Sample account",
    calendar: null as null | { id: string; name: string },
    pending: [],
  },
}));

vi.mock("@/lib/operations", () => ({
  operation: fixture.operation,
  useOperation: () => ({
    allowed: fixture.allowed,
    data: fixture.status,
    refetch: fixture.refetch,
    isLoading: false,
    isError: false,
  }),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  fixture.allowed = true;
  fixture.status.calendar = null;
});

describe("Outlook settings", () => {
  it("lists calendars and only selects the destination after explicit confirmation", async () => {
    fixture.operation
      .mockResolvedValueOnce([{ id: "crew", name: "Crew calendar" }])
      .mockResolvedValueOnce({ id: "crew", name: "Crew calendar" });
    fixture.refetch.mockResolvedValue({});
    render(<OutlookSettings />);
    expect(fixture.operation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose calendar" }));
    const calendar = await screen.findByRole("combobox", {
      name: "Writable calendar",
    });
    fireEvent.change(calendar, { target: { value: "crew" } });
    expect(fixture.operation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Use calendar" }));
    await waitFor(() =>
      expect(fixture.operation).toHaveBeenLastCalledWith(
        "/calendar/outlook/calendar",
        "PUT",
        { calendarId: "crew" },
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "New bookings will publish to Crew calendar.",
    );
  });

  it("requires an explicit action to publish previously scheduled installations", async () => {
    fixture.status.calendar = { id: "crew", name: "Crew calendar" };
    fixture.operation.mockResolvedValue({ queued: 2 });
    fixture.refetch.mockResolvedValue({});
    render(<OutlookSettings />);
    expect(fixture.operation).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Publish existing upcoming bookings",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "2 upcoming bookings queued for Outlook.",
    );
    expect(fixture.operation).toHaveBeenCalledWith(
      "/calendar/outlook/publish-upcoming",
      "POST",
    );
  });

  it("does not show connection controls outside the owner role", () => {
    fixture.allowed = false;
    const { container } = render(<OutlookSettings />);
    expect(container).toBeEmptyDOMElement();
  });
});
