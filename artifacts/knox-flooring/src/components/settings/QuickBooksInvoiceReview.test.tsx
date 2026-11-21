import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuickBooksInvoiceReview } from "./QuickBooksInvoiceReview";

const { operation } = vi.hoisted(() => ({ operation: vi.fn() }));
vi.mock("@/lib/operations", () => ({ operation }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const path = "/quickbooks/queue/queued-invoice/accounting";

it("shows the actual company, amounts, and account before approving an existing deposit", async () => {
  const onApproved = vi.fn().mockResolvedValue(undefined);
  operation
    .mockResolvedValueOnce({
      invoiceNumber: "INV-10",
      company: "Knoxville Books",
      deposit: 25,
      paid: 0,
      tax: 9.93,
      lines: [],
    })
    .mockResolvedValueOnce({
      fingerprint: "fingerprint",
      realmId: "123",
      discount: 0,
      tax: 9.93,
      deposit: 25,
      total: 109.93,
      balance: 84.93,
      attempt: { document: { Line: [] } },
      evidence: {
        customer: { Id: "8", DisplayName: "Customer" },
        reconciliation: {
          invoiceId: "16",
          depositAccount: { Id: "32", Name: "Operating Bank" },
        },
      },
    })
    .mockResolvedValueOnce({ status: "approved" });
  render(
    <QuickBooksInvoiceReview jobId="queued-invoice" onApproved={onApproved} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Review invoice accounting" }),
  );
  const id = await screen.findByLabelText("Existing QuickBooks invoice ID");
  expect(
    screen.getByRole("button", { name: "Preview accounting" }),
  ).toBeDisabled();
  fireEvent.change(id, { target: { value: "16" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview accounting" }));
  expect(await screen.findByText(/Operating Bank/)).toBeInTheDocument();
  expect(screen.getByText(/open balance \$84.93/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Approve invoice link" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText(
      "I approve linking this existing QuickBooks invoice.",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Approve invoice link" }));
  await waitFor(() => expect(onApproved).toHaveBeenCalledOnce());
  expect(operation.mock.calls).toEqual([
    [path],
    [
      `${path}/preview`,
      "POST",
      {
        existingInvoiceId: "16",
        discountAccountId: undefined,
        taxCodeId: undefined,
        taxableLineIds: [],
      },
    ],
    [
      `${path}/approve`,
      "POST",
      {
        request: {
          existingInvoiceId: "16",
          discountAccountId: undefined,
          taxCodeId: undefined,
          taxableLineIds: [],
        },
        fingerprint: "fingerprint",
      },
    ],
  ]);
});
