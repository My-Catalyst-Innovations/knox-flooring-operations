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
      environment: "production",
      deposit: 25,
      paid: 0,
      tax: 9.93,
      lines: [],
    })
    .mockResolvedValueOnce({
      fingerprint: "fingerprint",
      realmId: "123",
      environment: "production",
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

it("requires tax, discount and explicit owner confirmation for a real Intuit sandbox invoice", async () => {
  const onApproved = vi.fn().mockResolvedValue(undefined);
  operation.mockResolvedValueOnce({
    invoiceNumber: "TEST-INV-11", company: "Internal sandbox", environment: "sandbox",
    deposit: 0, paid: 0, tax: 8.33, discount: 10,
    lines: [{ id: "line1", description: "Oak flooring" }],
  }).mockResolvedValueOnce({
    fingerprint: "approved-sandbox-fingerprint", realmId: "456", environment: "sandbox",
    discount: 10, tax: 8.33, deposit: 0, total: 98.33, balance: 98.33,
    attempt: { document: { Line: [] } },
    evidence: { customer: { Id: "8", DisplayName: "Internal test customer" },
      discountAccount: { id: "70", name: "Discounts" }, tax: { id: "18", name: "Sales tax", percent: 9.25 } },
  }).mockResolvedValueOnce({ status: "approved" });
  render(<QuickBooksInvoiceReview jobId="queued-invoice" onApproved={onApproved}
    accounts={[{ Id: "70", Name: "Discounts", Active: true, AccountType: "Income", AccountSubType: "DiscountsRefundsGiven" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Review invoice accounting" }));
  expect(await screen.findByText("Intuit sandbox company")).toBeVisible();
  const preview = screen.getByRole("button", { name: "Preview accounting" });
  expect(preview).toBeDisabled();
  fireEvent.change(screen.getByLabelText("QuickBooks sales discount account"), { target: { value: "70" } });
  fireEvent.change(screen.getByLabelText("QuickBooks sales-tax code ID"), { target: { value: "18" } });
  expect(preview).toBeDisabled();
  fireEvent.click(screen.getByLabelText("Oak flooring"));
  fireEvent.click(preview);
  expect(await screen.findByText("Internal sandbox · sandbox company 456")).toBeVisible();
  const approve = screen.getByRole("button", { name: "Approve invoice export" });
  expect(approve).toBeDisabled();
  fireEvent.click(screen.getByLabelText("I approve creating this invoice in the QuickBooks sandbox."));
  fireEvent.click(approve);
  await waitFor(() => expect(onApproved).toHaveBeenCalledOnce());
  expect(operation).toHaveBeenLastCalledWith(`${path}/approve`, "POST", {
    request: { existingInvoiceId: undefined, discountAccountId: "70", taxCodeId: "18", taxableLineIds: ["line1"] },
    fingerprint: "approved-sandbox-fingerprint",
  });
});

it("requires an existing QuickBooks invoice for a payment-only sandbox invoice", async () => {
  operation.mockResolvedValueOnce({
    invoiceNumber: "TEST-PAID-12", company: "Internal sandbox", environment: "sandbox",
    deposit: 0, paid: 25, tax: 0, discount: 0, lines: [],
  });
  render(<QuickBooksInvoiceReview jobId="queued-invoice" onApproved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Review invoice accounting" }));
  expect(await screen.findByText(/already records this deposit or payment/)).toBeVisible();
  const preview = screen.getByRole("button", { name: "Preview accounting" });
  expect(preview).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Existing QuickBooks invoice ID"), { target: { value: "41" } });
  expect(preview).toBeEnabled();
  expect(screen.queryByLabelText("QuickBooks sales-tax code ID")).not.toBeInTheDocument();
  expect(operation).toHaveBeenCalledTimes(1);
});
