import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VendorBillSandbox } from "./VendorBillSandbox";
const state = vi.hoisted(() => ({ operation: vi.fn() }));
vi.mock("@/lib/operations", () => ({ operation: state.operation }));
vi.mock("./BillReceiptCoverage", () => ({
  BillReceiptCoverage: ({
    billId,
    onClose,
  }: {
    billId: string;
    onClose(): void;
  }) => (
    <section aria-label="Coverage entry">
      Selected bill {billId}
      <button onClick={onClose}>Close selected coverage</button>
    </section>
  ),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("opens coverage for the deliberately selected saved bill without changing bill approval or loading it automatically", async () => {
  state.operation.mockResolvedValue([
    {
      id: "bill-000081",
      status: "reviewed",
      payload: {
        mode: "review",
        billNumber: "000081",
        billDate: "2026-11-23",
        supplier: "Supply",
        totalCents: 446,
        lines: [],
        fingerprint: "f".repeat(64),
        priceDiffers: false,
      },
    },
  ]);
  render(<VendorBillSandbox mode="review" vendors={[]} />);
  const open = await screen.findByRole("button", {
    name: "Review receipts and original file",
  });
  expect(screen.queryByLabelText("Coverage entry")).not.toBeInTheDocument();
  expect(state.operation).toHaveBeenCalledExactlyOnceWith(
    "/quickbooks/vendor-bills?mode=review",
  );
  fireEvent.click(open);
  expect(screen.getByLabelText("Coverage entry")).toHaveTextContent(
    "Selected bill bill-000081",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Close selected coverage" }),
  );
  expect(screen.queryByLabelText("Coverage entry")).not.toBeInTheDocument();
  expect(state.operation).toHaveBeenCalledTimes(1);
});
