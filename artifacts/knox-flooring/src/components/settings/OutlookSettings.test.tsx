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
    mailConnected: false,
    mailboxEmail: null as string | null,
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
  fixture.status.mailConnected = false;
  fixture.status.mailboxEmail = null;
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

  it("requests mailbox consent only after the owner enables Outlook email", async () => {
    fixture.operation.mockRejectedValue(new Error("Microsoft sign-in is temporarily unavailable."));
    render(<OutlookSettings />);
    expect(screen.getByText(/does not read your inbox/)).toBeVisible();
    expect(fixture.operation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enable Outlook email" }));
    await waitFor(() => expect(fixture.operation).toHaveBeenCalledExactlyOnceWith(
      "/calendar/outlook/connect", "POST", { mail: true },
    ));
    expect(await screen.findByRole("alert")).toHaveTextContent("Microsoft sign-in is temporarily unavailable.");
    expect(screen.getByRole("button", { name: "Choose calendar" })).toBeEnabled();
  });

  it("shows the authorized mailbox without claiming inbox access or email delivery", () => {
    fixture.status.mailConnected = true;
    fixture.status.mailboxEmail = "owner@example.test";
    render(<OutlookSettings />);
    expect(screen.getByText(/Customer emails can be sent from owner@example.test/)).toBeVisible();
    expect(screen.getByText(/Submitted messages appear in Outlook Sent Items/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Enable Outlook email" })).not.toBeInTheDocument();
    expect(screen.getByText(/Password resets and other system emails/)).toBeVisible();
  });
});
