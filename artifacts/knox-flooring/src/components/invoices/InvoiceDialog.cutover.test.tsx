import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InvoiceDialog } from "./InvoiceDialog";
import { importedJob } from "@/test/active-job-fixtures";
import type { Job, Invoice } from "@/lib/types";
const state = vi.hoisted(() => ({
  job: null as Job | null,
  add: vi.fn(),
  update: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@/hooks/use-store", () => ({
  useStore: () => ({
    jobs: [state.job],
    addInvoice: state.add,
    updateInvoice: state.update,
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
beforeEach(() => {
  vi.clearAllMocks();
  state.add.mockReset();
  state.update.mockReset();
  state.job = structuredClone(importedJob);
  state.job.migrationCutover!.billing = {
    ...state.job.migrationCutover!.billing,
    current: true,
    status: "reviewed",
    ceilingCents: 10000,
    remainingCents: 10000,
  };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const confirmation = () =>
  screen.getByRole("checkbox", { name: /reviewed these exact lines/ });
async function lines(price = "50") {
  fireEvent.click(await screen.findByRole("button", { name: "Add Line" }));
  fireEvent.change(screen.getByLabelText("Line description"), {
    target: { value: "Reviewed remaining installation only" },
  });
  fireEvent.change(screen.getByLabelText("Unit price"), {
    target: { value: price },
  });
  fireEvent.click(confirmation());
}
it("never prefills a full contract, and unresolved billing cannot create a draft", async () => {
  state.job!.migrationCutover!.billing.current = false;
  render(<InvoiceDialog open presetJobId="job-1" onOpenChange={state.close} />);
  expect(
    await screen.findByText(/No full-contract lines are prefilled/),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Unit price")).toBeNull();
  expect(screen.getByRole("button", { name: "Create Invoice" })).toBeDisabled();
  expect(state.add).not.toHaveBeenCalled();
});
it("creates only confirmed unpaid remaining-work Draft lines with cutover revision and UUID", async () => {
  state.add.mockResolvedValue({ id: "invoice-1" });
  render(<InvoiceDialog open presetJobId="job-1" onOpenChange={state.close} />);
  await lines();
  expect(screen.getByLabelText("Deposit / Credit ($)")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Create Invoice" }));
  await waitFor(() => expect(state.add).toHaveBeenCalledOnce());
  expect(state.add.mock.calls[0][0]).toMatchObject({
    jobId: "job-1",
    status: "Draft",
    depositAmount: 0,
    expectedCutoverRevision: 1,
    requestKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
    lineItems: [
      {
        description: "Reviewed remaining installation only",
        quantity: 1,
        unitPrice: 50,
      },
    ],
  });
});
it("invalidates exact-line confirmation on edits and rejects a gross amount above the remaining ceiling", async () => {
  render(<InvoiceDialog open presetJobId="job-1" onOpenChange={state.close} />);
  await lines();
  fireEvent.change(screen.getByLabelText("Unit price"), {
    target: { value: "100.01" },
  });
  expect(confirmation()).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Create Invoice" })).toBeDisabled();
  fireEvent.click(confirmation());
  fireEvent.click(screen.getByRole("button", { name: "Create Invoice" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "gross invoice exceeds",
  );
  expect(state.add).not.toHaveBeenCalled();
});
it("freezes an uncertain create and replays the identical UUID and payload", async () => {
  state.add
    .mockRejectedValueOnce(new Error("Response lost after acceptance"))
    .mockResolvedValueOnce({ id: "invoice-1" });
  render(<InvoiceDialog open presetJobId="job-1" onOpenChange={state.close} />);
  await lines("4.46");
  fireEvent.click(screen.getByRole("button", { name: "Create Invoice" }));
  const retry = await screen.findByRole("button", {
    name: "Retry exact invoice request",
  });
  expect(screen.getByLabelText("Unit price")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  const payload = structuredClone(state.add.mock.calls[0][0]);
  fireEvent.click(retry);
  await waitFor(() => expect(state.add).toHaveBeenCalledTimes(2));
  expect(state.add.mock.calls[1][0]).toEqual(payload);
  expect(state.close).toHaveBeenCalledWith(false);
});

it("unlocks a proven stale409 rejection for fresh review and a new request UUID", async () => {
  state.add
    .mockRejectedValueOnce(
      Object.assign(new Error("The cutover revision changed"), {
        name: "ApiError",
        status: 409,
        data: { error: "The cutover revision changed" },
      }),
    )
    .mockResolvedValueOnce({ id: "invoice-2" });
  const props = { open: true, presetJobId: "job-1", onOpenChange: state.close };
  const { rerender } = render(<InvoiceDialog {...props} />);
  await lines();
  fireEvent.click(screen.getByRole("button", { name: "Create Invoice" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This request was rejected; no new invoice was saved by this attempt",
  );
  expect(screen.getByLabelText("Unit price")).toBeEnabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(confirmation()).not.toBeChecked();
  const previousKey = state.add.mock.calls[0][0].requestKey;
  state.job!.migrationCutover!.revision = 2;
  rerender(<InvoiceDialog {...props} />);
  fireEvent.change(screen.getByLabelText("Unit price"), {
    target: { value: "51" },
  });
  fireEvent.click(confirmation());
  fireEvent.click(screen.getByRole("button", { name: "Create Invoice" }));
  await waitFor(() => expect(state.add).toHaveBeenCalledTimes(2));
  expect(state.add.mock.calls[1][0]).toMatchObject({
    expectedCutoverRevision: 2,
    lineItems: [expect.objectContaining({ unitPrice: 51 })],
  });
  expect(state.add.mock.calls[1][0].requestKey).not.toBe(previousKey);
});
it("binds editable imported Draft changes to the saved invoice fingerprint", async () => {
  const invoice = {
    id: "invoice-1",
    invoiceNumber: "I-1",
    jobId: "job-1",
    status: "Draft",
    lineItems: [
      {
        id: "line-1",
        description: "Remaining work",
        category: "Labor",
        quantity: 1,
        unitPrice: 50,
      },
    ],
    total: 50,
    depositAmount: 0,
    paidAmount: 0,
    refundedAmount: 0,
    taxAmount: 0,
    discountAmount: 0,
    invoiceFinancialFingerprint: "f".repeat(64),
    notes: "",
    issueDate: "2026-11-23",
    dueDate: "2026-12-23",
  } as Invoice;
  render(<InvoiceDialog open invoice={invoice} onOpenChange={state.close} />);
  await screen.findByLabelText("Unit price");
  fireEvent.click(confirmation());
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() =>
    expect(state.update).toHaveBeenCalledWith(
      "invoice-1",
      expect.objectContaining({
        expectedCutoverRevision: 1,
        expectedInvoiceFingerprint: "f".repeat(64),
        depositAmount: 0,
        status: "Draft",
      }),
    ),
  );
});
