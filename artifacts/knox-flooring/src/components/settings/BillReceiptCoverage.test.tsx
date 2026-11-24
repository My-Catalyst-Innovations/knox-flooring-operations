import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BillReceiptCoverage } from "./BillReceiptCoverage";
import type {
  CoverageBillLine,
  CoverageBillStatus,
  CoverageOptions,
  CoveragePreview,
  CoverageReceipt,
} from "@/lib/receipt-bill-coverage";
const state = vi.hoisted(() => ({
  user: {
    id: "owner",
    role: "owner",
    actualRole: "owner",
    previewRole: null,
  } as any,
  operation: vi.fn(),
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/operations", () => ({ operation: state.operation }));
vi.mock("./OriginalBillDocuments", () => ({
  OriginalBillDocuments: ({ billId }: { billId: string }) => (
    <p>Private originals for {billId}</p>
  ),
}));
const line: CoverageBillLine = {
  key: "bill-a:0",
  billId: "bill-a",
  billLineIndex: 0,
  billNumber: "000081",
  supplier: "Supply",
  productId: "product-a",
  sku: "000042",
  productName: "Flooring",
  stockUnit: "box",
  quantity: "5.000001",
  unitCost: "4.460001",
  allocatedQuantity: "0.000000",
  remainingQuantity: "5.000001",
  sourceFingerprint: "a".repeat(64),
  vendorId: null,
  itemId: null,
  postedBillId: null,
  verification: "local_only",
  eligible: true,
  blockedReason: null,
};
const receipt: CoverageReceipt = {
  id: "receipt-line-a",
  receiptId: "receipt-a",
  orderId: "order-a",
  orderNumber: "PO-12",
  reference: "Delivery 01",
  supplier: "Supply",
  productId: "product-a",
  sku: "000042",
  productName: "Flooring",
  warehouseId: "warehouse-a",
  warehouseName: "Office",
  stockUnit: "box",
  quantity: "7.000001",
  unitCost: "4.460001",
  allocatedQuantity: "0.000000",
  remainingQuantity: "7.000001",
  sourceFingerprint: "b".repeat(64),
};
let options: CoverageOptions;
let saved: CoverageBillStatus;
let preview: CoveragePreview;
beforeEach(() => {
  vi.clearAllMocks();
  state.user = {
    id: "owner",
    role: "owner",
    actualRole: "owner",
    previewRole: null,
  };
  saved = {
    billId: "bill-a",
    mode: "local_review",
    coverageAvailable: true,
    blockedReason: null,
    allocations: [],
    documents: [],
    manualCases: [],
  };
  options = {
    mode: "local_review",
    company: null,
    bills: [
      structuredClone(line),
      { ...line, key: "bill-b:0", billId: "bill-b", billNumber: "000082" },
    ],
    receipts: [structuredClone(receipt)],
    allocations: [],
    documents: [],
    manualCases: [],
    observedAt: "2026-11-23T12:00:00Z",
    hasMore: false,
  };
  preview = {
    mode: "local_review",
    company: null,
    fingerprint: "f".repeat(64),
    identityWarnings: [],
    hasHistoricalIdentities: false,
    lines: [
      {
        receiptLineId: receipt.id,
        billId: line.billId,
        billLineIndex: 0,
        quantity: "2.000001",
        varianceNote: "",
        receipt,
        bill: line,
        receiptExtendedCost: "8.920006460001",
        billedExtendedCost: "8.920006460001",
        variance: "0.000000000000",
        varianceClassification: "none",
        displayVarianceCents: "0",
      },
    ],
    warnings: [],
    receiptResiduals: [{ id: receipt.id, remainingQuantity: "5.000000" }],
    billResiduals: [{ key: line.key, remainingQuantity: "3.000000" }],
    observedAt: "2026-11-23T12:00:00Z",
  };
  state.operation.mockImplementation(async (path: string) => {
    if (path.endsWith("/bills/bill-a")) return structuredClone(saved);
    if (path.includes("/options?")) return structuredClone(options);
    if (path.endsWith("/preview")) return structuredClone(preview);
    if (path.endsWith("/approve"))
      return {
        id: "approval-a",
        requestKey: "server",
        fingerprint: preview.fingerprint,
        allocations: [],
        createdAt: "2026-11-23T12:00:00Z",
        replayed: false,
      };
    throw new Error("Unexpected operation");
  });
});
afterEach(cleanup);
async function open() {
  render(<BillReceiptCoverage billId="bill-a" onClose={vi.fn()} />);
  await screen.findByLabelText("Bill line 1");
}
function fill(index = 1, billKey = "bill-a:0", quantity = "2.000001") {
  fireEvent.change(screen.getByLabelText(`Bill line ${index}`), {
    target: { value: billKey },
  });
  fireEvent.change(screen.getByLabelText(`Receipt line ${index}`), {
    target: { value: receipt.id },
  });
  fireEvent.change(screen.getByLabelText(`Coverage quantity ${index}`), {
    target: { value: quantity },
  });
  fireEvent.change(screen.getByLabelText("Owner coverage review note"), {
    target: { value: "Checked against original supplier documents" },
  });
}
async function prepare() {
  fireEvent.click(
    screen.getByRole("button", { name: "Preview receipt coverage" }),
  );
  await screen.findByLabelText("Reviewed receipt coverage");
}
function confirm() {
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I confirm the supplier, product and source identities, exact stock units, and these receipt and bill quantities.",
    }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I reviewed the acquisition prices and any explained price variances.",
    }),
  );
}
it("performs no reads or writes for role preview, nonowners or a mismatched actual role", () => {
  for (const user of [
    { id: "a", role: "operations" },
    { id: "a", role: "owner", previewRole: "operations" },
    { id: "a", role: "owner", actualRole: "sales" },
    null,
  ]) {
    state.user = user;
    const result = render(
      <BillReceiptCoverage billId="bill-a" onClose={vi.fn()} />,
    );
    expect(screen.getByText(/require the actual owner/)).toBeVisible();
    result.unmount();
  }
  expect(state.operation).not.toHaveBeenCalled();
});
it("opens read-only with local-only labels and preserves source SKU and bill-number zeros", async () => {
  await open();
  expect(state.operation.mock.calls).toEqual([
    ["/quickbooks/receipt-coverage/bills/bill-a"],
    ["/quickbooks/receipt-coverage/options?billId=bill-a"],
  ]);
  expect(screen.getByText(/Local owner review only/)).toBeVisible();
  expect(screen.getByRole("option", { name: /000081.*000042/ })).toBeVisible();
  expect(screen.getByText(/Job returns remain company stock/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Preview receipt coverage" }),
  ).toBeDisabled();
});
it("retains originals for blocked bills without fetching options or implying provider verification", async () => {
  saved.coverageAvailable = false;
  saved.blockedReason = "Owner bill review is still pending.";
  render(<BillReceiptCoverage billId="bill-a" onClose={vi.fn()} />);
  expect(await screen.findByText(saved.blockedReason)).toBeVisible();
  expect(screen.getByText("Private originals for bill-a")).toBeVisible();
  expect(state.operation).toHaveBeenCalledExactlyOnceWith(
    "/quickbooks/receipt-coverage/bills/bill-a",
  );
});
it("stops subsequent reads when the owner enters role preview during a pending status read", async () => {
  let resolve!: (value: CoverageBillStatus) => void;
  state.operation.mockReturnValue(
    new Promise<CoverageBillStatus>((done) => {
      resolve = done;
    }),
  );
  const result = render(
    <BillReceiptCoverage billId="bill-a" onClose={vi.fn()} />,
  );
  state.user = {
    id: "owner",
    role: "operations",
    actualRole: "owner",
    previewRole: "operations",
  };
  result.rerender(<BillReceiptCoverage billId="bill-a" onClose={vi.fn()} />);
  resolve(saved);
  await waitFor(() =>
    expect(screen.getByText(/require the actual owner/)).toBeVisible(),
  );
  expect(state.operation).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText("Bill line 1")).not.toBeInTheDocument();
});
it("reviews multiple bills against partial receipt quantities and invalidates all confirmation when edited", async () => {
  await open();
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Add coverage line" }));
  fill(2, "bill-b:0", "1.000000");
  await prepare();
  expect(state.operation).toHaveBeenCalledWith(
    "/quickbooks/receipt-coverage/preview",
    "POST",
    {
      billIds: ["bill-a", "bill-b"],
      allocations: [
        {
          receiptLineId: receipt.id,
          billId: "bill-a",
          billLineIndex: 0,
          quantity: "2.000001",
          varianceNote: "",
        },
        {
          receiptLineId: receipt.id,
          billId: "bill-b",
          billLineIndex: 0,
          quantity: "1.000000",
          varianceNote: "",
        },
      ],
      note: "Checked against original supplier documents",
    },
  );
  expect(screen.getByText(/Receipt total \$8\.92/)).toBeVisible();
  expect(screen.getByText(/8.920006460001/)).not.toBeVisible();
  fireEvent.click(screen.getByText("Exact source quantities and costs"));
  expect(screen.getByText(/8.920006460001/)).toBeVisible();
  expect(screen.getByText("Receipt Delivery 01: 5.000000")).toBeVisible();
  confirm();
  fireEvent.change(screen.getByLabelText("Coverage quantity 1"), {
    target: { value: "2.000002" },
  });
  expect(
    screen.queryByLabelText("Reviewed receipt coverage"),
  ).not.toBeInTheDocument();
  expect(
    state.operation.mock.calls.some((call) => call[0].endsWith("/approve")),
  ).toBe(false);
});
it("requires exact positive six-place quantities, no duplicate tuples, and a meaningful price variance reason", async () => {
  options.bills[0].unitCost = "4.460002";
  await open();
  fill();
  const button = screen.getByRole("button", {
    name: "Preview receipt coverage",
  });
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Price variance reason 1"), {
    target: { value: "Negotiated price confirmed on original bill" },
  });
  expect(button).toBeEnabled();
  for (const quantity of ["0", "-2", "2.0000001", "8", "2e1"]) {
    fireEvent.change(screen.getByLabelText("Coverage quantity 1"), {
      target: { value: quantity },
    });
    expect(button).toBeDisabled();
  }
  fireEvent.change(screen.getByLabelText("Coverage quantity 1"), {
    target: { value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add coverage line" }));
  fill(2);
  fireEvent.change(screen.getByLabelText("Price variance reason 2"), {
    target: { value: "Second explicit variance explanation" },
  });
  expect(button).toBeDisabled();
});
it("reviews proven purchase-unit rounding with blank variance notes and retains exact evidence", async () => {
  const source = {
    version: 1 as const,
    buyQuantity: "1",
    buyUnitCost: "64.15",
    approvedBuyUnitCost: "64.15",
    stockUnitsPerBuyUnit: "19.52",
    approvedStockUnitsPerBuyUnit: "19.52",
    printedLineAmountCents: "6415",
    stockQuantity: "19.52",
    billedStockUnitCost: "3.286373",
  };
  options.bills[0] = {
    ...line,
    quantity: "19.52",
    remainingQuantity: "19.52",
    unitCost: "3.286373",
    roundingSource: source,
  };
  options.receipts[0] = {
    ...receipt,
    quantity: "19.52",
    remainingQuantity: "19.52",
    unitCost: "3.286372",
  };
  preview.lines[0] = {
    ...preview.lines[0],
    receipt: options.receipts[0],
    bill: options.bills[0],
    varianceClassification: "unit_conversion_rounding",
    roundingEvidence: { ...source, receiptStockUnitCost: "3.286372" },
    variance: "0.000002000001",
  };
  await open();
  fill();
  expect(
    screen.getByRole("button", { name: "Preview receipt coverage" }),
  ).toBeEnabled();
  expect(screen.getByText(/printed bill line cents agree/)).toBeVisible();
  await prepare();
  expect(
    screen.getByText(/no additional price variance explanation/),
  ).toBeVisible();
  fireEvent.click(screen.getByText("Exact source quantities and costs"));
  expect(
    screen.getByText(/Original purchase 1 units at \$64.15/),
  ).toBeVisible();
  expect(screen.getByText(/Exact difference 0.000002000001/)).toBeVisible();
});
it("refuses a preview that labels an unproven price difference as conversion rounding", async () => {
  await open();
  fill();
  preview.lines[0].varianceClassification = "unit_conversion_rounding";
  fireEvent.click(
    screen.getByRole("button", { name: "Preview receipt coverage" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "rounding evidence could not be verified",
  );
  expect(
    screen.queryByRole("button", { name: "Save reviewed receipt coverage" }),
  ).not.toBeInTheDocument();
});
it("sums shared receipt budgets across different bill lines before offering a preview", async () => {
  options.receipts[0].remainingQuantity = "3.000001";
  await open();
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Add coverage line" }));
  fill(2, "bill-b:0", "2.000000");
  expect(
    screen.getByRole("button", { name: "Preview receipt coverage" }),
  ).toBeDisabled();
  expect(screen.getByText(/Combined selections exceed/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Coverage quantity 2"), {
    target: { value: "1.000000" },
  });
  expect(
    screen.getByRole("button", { name: "Preview receipt coverage" }),
  ).toBeEnabled();
});
it("requires both explicit approvals and saves only local coverage without provider or stock routes", async () => {
  await open();
  fill();
  await prepare();
  const button = screen.getByRole("button", {
    name: "Save reviewed receipt coverage",
  });
  expect(button).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I confirm the supplier, product and source identities, exact stock units, and these receipt and bill quantities.",
    }),
  );
  expect(button).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I reviewed the acquisition prices and any explained price variances.",
    }),
  );
  fireEvent.click(button);
  expect(await screen.findByText(/Local receipt coverage saved/)).toBeVisible();
  expect(state.operation).toHaveBeenCalledWith(
    "/quickbooks/receipt-coverage/approve",
    "POST",
    expect.objectContaining({
      requestKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
      fingerprint: preview.fingerprint,
      confirmQuantities: true,
      confirmPriceVariances: true,
      confirmSourceIdentities: true,
    }),
  );
  expect(
    state.operation.mock.calls.every(([path]) =>
      path.startsWith("/quickbooks/receipt-coverage/"),
    ),
  ).toBe(true);
});
it("makes owner-reconciled legacy source identities explicit without changing the saved source", async () => {
  preview.hasHistoricalIdentities = true;
  preview.identityWarnings = [
    "Verify legacy supplier SKU 000042 against this receipt.",
  ];
  await open();
  fill();
  await prepare();
  expect(screen.getByText(/includes legacy source identities/)).toBeVisible();
  expect(
    screen.getByText("Verify legacy supplier SKU 000042 against this receipt."),
  ).toBeVisible();
  expect(
    screen.getByRole("checkbox", {
      name: /supplier, product and source identities/,
    }),
  ).not.toBeChecked();
  expect(
    state.operation.mock.calls.some(([path]) => path.endsWith("/approve")),
  ).toBe(false);
});
it.each([401, 403, 409])(
  "keeps the exact approval payload and UUID after a lost response followed by %s",
  async (status) => {
    await open();
    fill();
    await prepare();
    confirm();
    let failures = 0;
    const implementation = state.operation.getMockImplementation()!;
    state.operation.mockImplementation(async (...args) => {
      if (args[0].endsWith("/approve") && failures < 2) {
        failures += 1;
        throw failures === 1
          ? new Error("connection lost")
          : Object.assign(new Error("Retry rejected before reconciliation"), {
              name: "ApiError",
              status,
            });
      }
      return implementation(...args);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save reviewed receipt coverage" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "outcome is unknown",
    );
    expect(screen.getByLabelText("Coverage quantity 1")).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry same coverage approval" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "outcome is unknown",
    );
    expect(screen.getByLabelText("Coverage quantity 1")).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry same coverage approval" }),
    );
    await screen.findByText(/Local receipt coverage saved/);
    const approvals = state.operation.mock.calls.filter(([path]) =>
      path.endsWith("/approve"),
    );
    expect(approvals).toHaveLength(3);
    expect(approvals[0]).toEqual(approvals[1]);
    expect(approvals[0]).toEqual(approvals[2]);
  },
);
it("unlocks a proven stale409 rejection for a new review and a new immutable request key", async () => {
  await open();
  fill();
  await prepare();
  confirm();
  let failed = false;
  const implementation = state.operation.getMockImplementation()!;
  state.operation.mockImplementation(async (...args) => {
    if (args[0].endsWith("/approve") && !failed) {
      failed = true;
      throw Object.assign(new Error("Receipt changed"), {
        name: "ApiError",
        status: 409,
      });
    }
    return implementation(...args);
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save reviewed receipt coverage" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("rejected");
  expect(screen.getByLabelText("Coverage quantity 1")).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Coverage quantity 1"), {
    target: { value: "1.000001" },
  });
  await prepare();
  confirm();
  fireEvent.click(
    screen.getByRole("button", { name: "Save reviewed receipt coverage" }),
  );
  await screen.findByText(/Local receipt coverage saved/);
  const approvals = state.operation.mock.calls.filter(([path]) =>
    path.endsWith("/approve"),
  );
  expect(approvals[0][2].requestKey).not.toEqual(approvals[1][2].requestKey);
});
it("refuses a preview that switches mode or accounting company instead of offering approval", async () => {
  await open();
  fill();
  preview.mode = "quickbooks_verified";
  preview.company = {
    connectionId: "other",
    realmId: "other",
    environment: "production",
    companyName: "Other",
  };
  fireEvent.click(
    screen.getByRole("button", { name: "Preview receipt coverage" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "accounting scope changed",
  );
  expect(
    screen.queryByRole("button", { name: "Save reviewed receipt coverage" }),
  ).not.toBeInTheDocument();
});
it("explicitly reconciles prior local coverage without counting the receipt twice or overwriting its price", async () => {
  saved.mode = "quickbooks_verified";
  options.mode = "quickbooks_verified";
  options.company = {
    connectionId: "qbo",
    realmId: "123",
    environment: "sandbox",
    companyName: "Sandbox company",
  };
  options.bills[0] = {
    ...line,
    unitCost: "4.460002",
    verification: "verified",
    vendorId: "001",
    itemId: "002",
    postedBillId: "003",
  };
  options.receipts[0].remainingQuantity = "0.000000";
  options.allocations = [
    {
      id: "local-a",
      approvalId: "approval-local",
      receiptLineId: receipt.id,
      billId: "old-local",
      billLineIndex: 0,
      productId: line.productId,
      quantity: "5.000001",
      stockUnit: "box",
      receiptUnitCost: "4.460001",
      billedUnitCost: "4.460001",
      varianceNote: "",
      createdAt: "2026-11-23T12:00:00Z",
      mode: "local_review",
      sourceBillNumber: "000081",
      providerBoundQuantity: "1.000000",
      unboundQuantity: "4.000001",
    },
  ];
  await open();
  fill();
  const button = screen.getByRole("button", {
    name: "Preview receipt coverage",
  });
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Prior local coverage 1"), {
    target: { value: "local-a" },
  });
  fireEvent.change(screen.getByLabelText("Price variance reason 1"), {
    target: { value: "Receipt rate differs from negotiated bill" },
  });
  expect(button).toBeDisabled();
  fireEvent.change(
    screen.getByLabelText("Prior coverage reconciliation reason 1"),
    { target: { value: "Verified revised amount against supplier original" } },
  );
  expect(button).toBeEnabled();
  expect(
    screen.getByText(/Receipt coverage is not counted a second time/),
  ).toBeVisible();
  preview.mode = options.mode;
  preview.company = options.company;
  await prepare();
  expect(state.operation).toHaveBeenCalledWith(
    expect.stringContaining("/preview"),
    "POST",
    expect.objectContaining({
      allocations: [
        expect.objectContaining({
          existingAllocationId: "local-a",
          reconciliationNote:
            "Verified revised amount against supplier original",
          quantity: "2.000001",
        }),
      ],
    }),
  );
});
it("can combine new receipt coverage and a prior local endorsement for the same provider bill line", async () => {
  saved.mode = "quickbooks_verified";
  options.mode = "quickbooks_verified";
  options.company = {
    connectionId: "qbo",
    realmId: "123",
    environment: "sandbox",
    companyName: "Sandbox company",
  };
  options.bills[0] = {
    ...line,
    verification: "verified",
    vendorId: "1",
    itemId: "2",
    postedBillId: "3",
  };
  options.receipts[0].remainingQuantity = "1.000000";
  options.allocations = [
    {
      id: "local-a",
      approvalId: "prior",
      receiptLineId: receipt.id,
      billId: "local-bill",
      billLineIndex: 0,
      productId: line.productId,
      quantity: "3.000000",
      stockUnit: "box",
      receiptUnitCost: line.unitCost,
      billedUnitCost: line.unitCost,
      varianceNote: "",
      createdAt: "2026-11-23T12:00:00Z",
      mode: "local_review",
      sourceBillNumber: "000081",
      providerBoundQuantity: "0.000000",
      unboundQuantity: "3.000000",
    },
  ];
  await open();
  fill(1, "bill-a:0", "1.000000");
  fireEvent.click(screen.getByRole("button", { name: "Add coverage line" }));
  fill(2, "bill-a:0", "3.000000");
  expect(
    screen.getByRole("button", { name: "Preview receipt coverage" }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Prior local coverage 2"), {
    target: { value: "local-a" },
  });
  expect(
    screen.getByRole("button", { name: "Preview receipt coverage" }),
  ).toBeEnabled();
  preview.mode = options.mode;
  preview.company = options.company;
  await prepare();
  expect(state.operation).toHaveBeenCalledWith(
    expect.stringContaining("/preview"),
    "POST",
    expect.objectContaining({
      allocations: [
        expect.objectContaining({ quantity: "1.000000" }),
        expect.objectContaining({
          quantity: "3.000000",
          existingAllocationId: "local-a",
        }),
      ],
    }),
  );
});
it("does not expose a provider review when the returned company scope is missing", async () => {
  saved.mode = "quickbooks_verified";
  options.mode = "quickbooks_verified";
  options.company = null;
  render(<BillReceiptCoverage billId="bill-a" onClose={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "accounting scope could not be verified",
  );
  expect(screen.queryByLabelText("Bill line 1")).not.toBeInTheDocument();
  expect(screen.getByText("Private originals for bill-a")).toBeVisible();
});
it("does not offer equal-priced receipt stock from a different supplier", async () => {
  options.receipts.push({
    ...receipt,
    id: "other-supplier",
    orderNumber: "OTHER-PO",
    supplier: "Other supplier",
  });
  await open();
  fireEvent.change(screen.getByLabelText("Bill line 1"), {
    target: { value: "bill-a:0" },
  });
  expect(
    screen.queryByRole("option", { name: /OTHER-PO/ }),
  ).not.toBeInTheDocument();
});
