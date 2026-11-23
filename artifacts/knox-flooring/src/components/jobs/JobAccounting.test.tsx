import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JobAccounting } from "./JobAccounting";
import { expenseReceiptHref, moneyInputCents } from "@/lib/job-accounting";

const state = vi.hoisted(() => ({
  owner: true,
  operation: vi.fn(),
  refetch: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./JobQuickBooksProject", () => ({ JobQuickBooksProject: () => null }));
vi.mock("./JobCostExportReview", () => ({ JobCostExportReview: () => null }));
vi.mock("@/lib/operations", () => ({
  operation: state.operation,
  currency: (value: number) => `$${value.toFixed(2)}`,
  useRefreshOperations: () => state.refresh,
  useOperation: (path: string) => ({
    allowed: state.owner,
    refetch: state.refetch,
    data: path.endsWith("/files")
      ? { documents: [{ id: "receipt-1", name: "Actual receipt.pdf" }] }
      : path.endsWith("/options")
        ? {
            enabled: true,
            company: { name: "Company", connectionId: "connection" },
            employees: [{ id: "worker-1", name: "Verified individual" }],
            vendors: [],
            serviceItems: [{ id: "service-1", name: "Installation" }],
          }
        : {
            labor: [
              {
                id: "labor-1",
                jobId: "job-1",
                date: "2026-11-23",
                hours: 4,
                crew: "Crew",
                revision: 2,
                workerType: "unmapped",
                costReviewed: false,
                hourlyCost: null,
                exportState: "unreviewed",
              },
            ],
            expenses: [],
            warnings: [],
            totals: {
              trackedLaborCost: null,
              unpricedLaborCount: 1,
              trackedExpenseCost: 0,
            },
          },
  }),
}));
beforeEach(() => {
  state.owner = true;
  state.operation.mockReset();
  state.refetch.mockReset().mockResolvedValue(undefined);
  state.refresh.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);
it("requires one verified individual and explicit cost review before pricing labor", async () => {
  render(<JobAccounting jobId="job-1" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Review individual worker and cost" }),
  );
  fireEvent.change(screen.getByLabelText("Worker type"), {
    target: { value: "Employee" },
  });
  fireEvent.change(screen.getByLabelText("Verified worker"), {
    target: { value: "worker-1" },
  });
  fireEvent.change(screen.getByLabelText("Service item"), {
    target: { value: "service-1" },
  });
  fireEvent.change(screen.getByLabelText("Local hourly cost (USD)"), {
    target: { value: "25.75" },
  });
  const save = screen.getByRole("button", { name: "Save reviewed labor cost" });
  expect(save).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText(/This entry records one person's actual hours/),
  );
  fireEvent.click(save);
  await waitFor(() =>
    expect(state.operation).toHaveBeenCalledWith(
      "/jobs/job-1/labor/labor-1/accounting",
      "PATCH",
      {
        revision: 2,
        singleWorkerConfirmed: true,
        workerType: "Employee",
        workerExternalId: "worker-1",
        workerName: "Verified individual",
        serviceItemExternalId: "service-1",
        hourlyCost: 25.75,
      },
    ),
  );
});
it("saves explicit receipt facts in integer cents and preserves the request key on an interrupted retry", async () => {
  state.operation
    .mockRejectedValueOnce(new Error("Request interrupted"))
    .mockResolvedValueOnce({});
  render(<JobAccounting jobId="job-1" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Record receipt-backed expense" }),
  );
  expect(
    screen.getByRole("button", { name: "Save receipt expense" }),
  ).toBeDisabled();
  for (const [label, value] of [
    ["Expense type", "paid_purchase"],
    ["Description", "Disposal"],
    ["Vendor on receipt", "Actual vendor"],
    ["Cost category", "other"],
    ["Transaction date", "2026-11-23"],
    ["Receipt currency", "USD"],
    ["Gross receipt amount (USD)", "123.45"],
    ["Tax included in receipt amount (USD; enter 0 if none)", "3.45"],
    ["Receipt or bill reference", "R-123"],
    ["Receipt document", "receipt-1"],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Save receipt expense" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Request interrupted",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save receipt expense" }));
  await waitFor(() => expect(state.operation).toHaveBeenCalledTimes(2));
  expect(state.operation.mock.calls[0][2]).toEqual(
    expect.objectContaining({
      amountCents: 12345,
      taxCents: 345,
      receiptDocumentId: "receipt-1",
      currency: "USD",
    }),
  );
  expect(state.operation.mock.calls[1][2]).toEqual(
    state.operation.mock.calls[0][2],
  );
});
it("hides owner accounting controls from other roles", () => {
  state.owner = false;
  render(<JobAccounting jobId="job-1" />);
  expect(screen.queryByText("Reviewed job costs")).not.toBeInTheDocument();
});
it("rejects fractional cents and unsafe receipt destinations", () => {
  expect(moneyInputCents("123.45")).toBe(12345);
  expect(moneyInputCents("1.234")).toBeNull();
  expect(moneyInputCents("-3")).toBeNull();
  expect(expenseReceiptHref("https://external.test/receipt")).toBeNull();
  expect(expenseReceiptHref("javascript:alert(1)")).toBeNull();
  expect(expenseReceiptHref("/api/storage/objects/private/receipt")).toBe(
    "/api/storage/objects/private/receipt",
  );
});
