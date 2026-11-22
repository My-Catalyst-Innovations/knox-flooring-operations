import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuickBooksStockReconciliation } from "./QuickBooksStockReconciliation";

const { operation } = vi.hoisted(() => ({ operation: vi.fn() }));
vi.mock("@/lib/operations", () => ({ operation }));

const path = "/quickbooks/stock-reconciliation";
const choice = {
  productId: "product",
  returnId: "return",
  invoiceId: "invoice",
  billId: "bill",
  accountId: "expense",
  date: "2026-11-20",
  connectionId: "connection",
};
const stock = {
  productId: "product",
  sku: "TILE-001",
  name: "Fictional tile",
  unit: "box",
  itemId: "35",
  warehouseOnHand: 40,
  inTransit: 2.500001,
  localOnHand: 42.500001,
  quickBooksOnHand: 40,
  difference: 2.500001,
  status: "different",
};
const comparison = {
  rows: [stock],
  connectionId: "connection",
  realmId: "456",
  company: "Fictional Flooring Books",
  environment: "sandbox",
  adjustmentEnabled: true,
  observedAt: "2026-11-20T22:30:00Z",
};
const options = {
  returns: [
    {
      id: "return",
      jobId: "job",
      quantity: 2.500001,
      reason: "Intact cartons returned",
      createdAt: "2026-11-20T18:00:00Z",
    },
  ],
  invoices: [
    { id: "invoice", jobId: "job", number: "INV-1", jobNumber: "JOB-1" },
    { id: "other", jobId: "other", number: "INV-OTHER", jobNumber: "JOB-2" },
  ],
  bills: [{ id: "bill", number: "BILL-1", supplier: "Fictional supplier" }],
  accounts: [{ id: "expense", name: "Inventory adjustments", type: "Expense" }],
  attempts: [],
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function mount() {
  return render(
    <QuickBooksStockReconciliation realmId="456" environment="sandbox" />,
  );
}

it("reads the provider only when requested, shows precise transit and discrepancy, and blocks a different realm", async () => {
  operation
    .mockResolvedValueOnce({ ...comparison, adjustmentEnabled: false })
    .mockResolvedValueOnce({ ...comparison, realmId: "other" });
  mount();
  expect(operation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Compare stock" }));
  const table = await screen.findByRole("table", {
    name: "Catalyst and QuickBooks stock comparison",
  });
  expect(within(table).getAllByText("2.500001")).toHaveLength(2);
  expect(within(table).getByText("42.500001")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Review returned stock/ }),
  ).not.toBeInTheDocument();
  expect(operation).toHaveBeenCalledExactlyOnceWith(path);

  fireEvent.click(screen.getByRole("button", { name: "Refresh quantities" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The connected QuickBooks company changed",
  );
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

it("shows the receipt, bill, invoice, exact quantity, and account before explicit owner approval", async () => {
  operation
    .mockResolvedValueOnce(comparison)
    .mockResolvedValueOnce(options)
    .mockResolvedValueOnce({
      approved: {
        choice,
        fingerprint: "preview-hash",
        before: 40,
        target: 42.500001,
        document: {
          DocNumber: "CW-STOCK-1",
          TxnDate: choice.date,
          AdjustAccountRef: { value: "expense" },
          Line: [{ ItemAdjustmentLineDetail: { QtyDiff: 2.500001 } }],
        },
      },
      evidence: {
        receiptId: "receipt",
        receiptReference: "REC-1",
        orderNumber: "PO-1",
        received: 50,
        billId: "bill",
        billNumber: "BILL-1",
        invoiceId: "invoice",
        invoiceNumber: "INV-1",
        jobNumber: "JOB-1",
        issued: 10,
        returned: 2.500001,
        returnReason: "Intact cartons returned",
        local: 42.500001,
        itemId: "35",
        account: {
          Id: "expense",
          Name: "Inventory adjustments",
          AccountType: "Expense",
        },
        offering: "QuickBooks Online Plus",
      },
    })
    .mockResolvedValueOnce({
      adjustmentId: "ADJ-123",
      recovered: false,
      observed: 42.500001,
      target: 42.500001,
      balanceMatches: true,
    })
    .mockResolvedValueOnce(options);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Compare stock" }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Review returned stock for TILE-001",
    }),
  );
  fireEvent.change(await screen.findByLabelText("Recorded job return"), {
    target: { value: "return" },
  });
  expect(
    screen.queryByRole("option", { name: /INV-OTHER/ }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Customer invoice", { exact: true }), {
    target: { value: "invoice" },
  });
  fireEvent.change(screen.getByLabelText("Supplier bill", { exact: true }), {
    target: { value: "bill" },
  });
  fireEvent.change(
    screen.getByLabelText("QuickBooks adjustment account", { exact: true }),
    { target: { value: "expense" } },
  );
  fireEvent.change(screen.getByLabelText("Posting date", { exact: true }), {
    target: { value: choice.date },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Preview stock adjustment" }),
  );
  expect(await screen.findByText(/PO-1 · REC-1 · 50 box/)).toBeVisible();
  expect(screen.getByRole("link", { name: "INV-1 · JOB-1" })).toHaveAttribute(
    "href",
    "/invoices?invoice=invoice",
  );
  expect(screen.getByText(/40 → 42\.500001 box · Add 2\.500001/)).toBeVisible();
  expect(
    screen.getByText("Inventory adjustments · Expense · expense"),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Approve stock adjustment" }),
  ).toBeDisabled();
  expect(operation.mock.calls).toEqual([
    [path],
    [`${path}/product`],
    [`${path}/preview`, "POST", choice],
  ]);
  fireEvent.click(
    screen.getByLabelText(
      "I approve this quantity adjustment in the displayed QuickBooks company.",
    ),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Approve stock adjustment" }),
  );
  expect(
    await screen.findByText("QuickBooks adjustment ADJ-123"),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Verified balance of 42.500001 matches the approved quantity.",
    ),
  ).toBeVisible();
  expect(operation).toHaveBeenCalledWith(`${path}/approve`, "POST", {
    choice,
    fingerprint: "preview-hash",
  });
});

it("rechecks a submitted failure using only its stored review proof and reports a changed balance", async () => {
  const attempts = [
    {
      status: "failed",
      submitted: true,
      lastError: "Provider response was unavailable",
      choice,
      fingerprint: "stored-hash",
      reference: "CW-RETURN-42",
    },
    {
      status: "failed",
      submitted: false,
      lastError: "Preview did not pass",
      choice,
      fingerprint: "unsubmitted",
    },
  ];
  operation
    .mockResolvedValueOnce(comparison)
    .mockResolvedValueOnce({ ...options, attempts })
    .mockResolvedValueOnce({
      adjustmentId: "123",
      recovered: true,
      observed: 45,
      target: 42.500001,
      balanceMatches: false,
    })
    .mockResolvedValueOnce(options);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Compare stock" }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Review returned stock for TILE-001",
    }),
  );
  const recheck = await screen.findByRole("button", {
    name: "Recheck prior submission",
  });
  expect(screen.getByText("QuickBooks reference CW-RETURN-42")).toBeVisible();
  const existingId = screen.getByLabelText(
    "QuickBooks adjustment ID (optional)",
  );
  fireEvent.change(existingId, { target: { value: "not-a-provider-id" } });
  expect(recheck).toBeDisabled();
  fireEvent.change(existingId, { target: { value: "123" } });
  fireEvent.click(recheck);
  expect(
    await screen.findByText("Existing QuickBooks adjustment 123"),
  ).toBeVisible();
  expect(
    screen.getByText(
      /Approved target 42\.500001 · Current QuickBooks balance 45/,
    ),
  ).toBeVisible();
  await waitFor(() =>
    expect(operation.mock.calls).toEqual([
      [path],
      [`${path}/product`],
      [
        `${path}/approve`,
        "POST",
        { choice, fingerprint: "stored-hash", adjustmentId: "123" },
      ],
      [`${path}/product`],
    ]),
  );
});
