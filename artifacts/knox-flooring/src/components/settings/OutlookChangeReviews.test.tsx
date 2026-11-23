import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OutlookChangeReviews, type OutlookChangeReview } from "./OutlookChangeReviews";

const state = vi.hoisted(() => ({ rows: [] as OutlookChangeReview[], operation: vi.fn(), refetch: vi.fn() }));
vi.mock("@/lib/operations", () => ({
  operation: state.operation, installationBookingHref: ({ id }: { id: string }) => `/calendar?booking=${id}`,
  useOperation: () => ({ allowed: true, data: { reviews: state.rows }, refetch: state.refetch, isLoading: false, isFetching: false, error: null }),
}));
const fixture = (removed = false): OutlookChangeReview => ({
  bookingId: "booking", jobNumber: "J-1011", crewName: "Install team", bookingRevision: 4, reviewRevision: 2,
  kind: removed ? "deleted" : "edited", detectedAt: "2026-11-23T12:00:00Z",
  local: { startAt: "2026-11-24T14:00:00Z", endAt: "2026-11-24T16:00:00Z", status: "Confirmed", plannedLaborHours: 2 },
  previous: null,
  remote: removed ? null : { id: "remote", etag: "remote-version", changeKey: "change", subject: "Revised installation",
    startAt: "2026-11-24T15:00:00Z", endAt: "2026-11-24T17:00:00Z", isCancelled: false, isAllDay: false, type: "singleInstance" },
});
afterEach(() => { cleanup(); vi.resetAllMocks(); state.rows = []; });

it("requires a note and submits the displayed booking/review versions", async () => {
  state.rows = [fixture()]; state.operation.mockResolvedValue({ resolved: true });
  render(<OutlookChangeReviews />);
  const choice = screen.getByRole("button", { name: "Use Outlook schedule" });
  expect(choice).toBeDisabled();
  expect(screen.getByRole("link", { name: "J-1011" })).toHaveAttribute("href", "/calendar?booking=booking");
  fireEvent.change(screen.getByLabelText("Review note for J-1011"), { target: { value: "Customer requested the later time" } });
  fireEvent.click(choice);
  expect(await screen.findByRole("status")).toHaveTextContent("J-1011: calendar change resolved.");
  expect(state.operation).toHaveBeenCalledWith("/calendar/outlook/reviews/booking/resolve", "POST", {
    bookingRevision: 4, reviewRevision: 2, action: "use_outlook", note: "Customer requested the later time",
  });
});

it("makes cancellation explicit when the remote event was deleted", async () => {
  state.rows = [fixture(true)]; state.operation.mockResolvedValue({ resolved: true });
  render(<OutlookChangeReviews />);
  const article = screen.getByRole("article", { name: "J-1011 calendar change" });
  expect(within(article).getByText(/job and its history remain/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Review note for J-1011"), { target: { value: "Customer canceled this installation" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel this booking" }));
  expect(await screen.findByRole("status")).toBeVisible();
  expect(state.operation.mock.calls[0][2].action).toBe("use_outlook");
});

it("keeps a stale review visible and reports the server conflict", async () => {
  state.rows = [fixture()]; state.operation.mockRejectedValue(new Error("The Outlook event changed again. Refresh the review."));
  render(<OutlookChangeReviews />);
  fireEvent.change(screen.getByLabelText("Review note for J-1011"), { target: { value: "Keep agreed time" } });
  fireEvent.click(screen.getByRole("button", { name: "Keep app schedule" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("changed again");
  expect(screen.getByRole("article")).toBeVisible();
  expect(screen.queryByText(/calendar change resolved/)).not.toBeInTheDocument();
});
