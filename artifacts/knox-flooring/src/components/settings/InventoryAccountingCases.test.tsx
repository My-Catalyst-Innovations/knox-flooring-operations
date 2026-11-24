import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  InventoryAccountingCase,
  InventoryAccountingOptions,
  InventoryAccountingPreview,
  StockReturnPlan,
} from "@workspace/domain";
import { InventoryAccountingCases } from "./InventoryAccountingCases";

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
const path = "/quickbooks/inventory-accounting-cases";
const manual: StockReturnPlan = {
  kind: "manual_review",
  reasonCodes: ["receipt_bill_coverage_unverified"],
  explanations: ["Original provider bill coverage is not verified."],
  providerSubmissionAllowed: false,
  financialActionsAllowed: false,
  revaluesInventory: false,
};
const ready: StockReturnPlan = {
  kind: "ready_quantity_plan",
  quantityDifference: "2.000001",
  returnIds: ["return-a"],
  returnQuantities: [{ returnId: "return-a", quantity: "2.000001" }],
  invoiceIds: ["invoice-a"],
  sourceRefs: { receipts: ["000081"], bills: ["000042"] },
  scopeFingerprint: "a".repeat(64),
  warnings: ["Review this quantity with the accounting operator."],
  providerSubmissionAllowed: false,
  financialActionsAllowed: false,
  revaluesInventory: false,
};
let options: InventoryAccountingOptions;
let preview: InventoryAccountingPreview;
let saved: InventoryAccountingCase;
beforeEach(() => {
  vi.clearAllMocks();
  state.user = {
    id: "owner",
    role: "owner",
    actualRole: "owner",
    previewRole: null,
  };
  saved = {
    id: "case-a",
    kind: "manual_review",
    productId: "product-a",
    jobId: "job-a",
    note: "Check original source documents",
    reasonCodes: ["receipt_bill_coverage_unverified"],
    reference: "WORKS-CASE-000001",
    plan: structuredClone(manual),
    company: null,
    events: [],
    createdAt: "2026-11-23T12:00:00Z",
  };
  options = {
    product: { id: "product-a", sku: "000042", name: "Flooring", unit: "sqft" },
    jobs: [
      { id: "job-a", number: "JOB-01", customerName: "Customer A" },
      { id: "job-b", number: "JOB-02", customerName: "Customer B" },
    ],
    returns: [
      {
        id: "return-a",
        jobId: "job-a",
        issueId: "issue-a",
        quantity: "2.000001",
        reason: "Unused stock",
        createdAt: "2026-11-23",
      },
      {
        id: "return-b",
        jobId: "job-a",
        issueId: "issue-b",
        quantity: "1.000001",
        reason: "Second delivery",
        createdAt: "2026-11-23",
      },
      {
        id: "other-return",
        jobId: "job-b",
        issueId: "issue-c",
        quantity: "1",
        reason: "Other job",
        createdAt: "2026-11-23",
      },
    ],
    cases: [],
    hasMore: false,
  };
  preview = {
    choice: {
      productId: "product-a",
      jobId: "job-a",
      returnIds: ["return-a"],
      note: "Check original source documents",
    },
    fingerprint: "f".repeat(64),
    plan: structuredClone(manual),
    observedAt: "2026-11-23T12:00:00Z",
    company: null,
  };
  state.operation.mockImplementation(async (url: string) => {
    if (url.includes("/options?")) return structuredClone(options);
    if (url.endsWith("/preview")) return structuredClone(preview);
    if (url === path) return { case: structuredClone(saved), replayed: false };
    if (url.endsWith("/notes") || url.endsWith("/verify-adjustment"))
      return structuredClone(saved);
    throw new Error(`Unexpected route ${url}`);
  });
});
afterEach(cleanup);
async function open() {
  render(<InventoryAccountingCases productId="product-a" />);
  await screen.findByLabelText("Job for returned material");
}
function fill() {
  fireEvent.change(screen.getByLabelText("Job for returned material"), {
    target: { value: "job-a" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /Return return-a/ }));
  fireEvent.change(screen.getByLabelText("Accounting review note"), {
    target: { value: preview.choice.note },
  });
}
async function prepare() {
  fireEvent.click(
    screen.getByRole("button", { name: "Preview inventory accounting case" }),
  );
  await screen.findByLabelText("Reviewed inventory accounting case");
}
function confirm() {
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the selected returns/ }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I understand saving this case/ }),
  );
}
it("makes no requests for nonowners, role preview or mismatched actual role", () => {
  for (const user of [
    null,
    { role: "operations" },
    { role: "owner", previewRole: "sales" },
    { role: "owner", actualRole: "sales" },
  ]) {
    state.user = user;
    const view = render(<InventoryAccountingCases productId="product-a" />);
    expect(screen.getByText(/actual owner outside role preview/)).toBeVisible();
    view.unmount();
  }
  expect(state.operation).not.toHaveBeenCalled();
});
it("opens read-only for a product without requiring a QuickBooks company", async () => {
  await open();
  expect(state.operation).toHaveBeenCalledExactlyOnceWith(
    `${path}/options?productId=product-a`,
  );
  expect(screen.getByText("000042 · Flooring · sqft")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Preview inventory accounting case" }),
  ).toBeDisabled();
});
it("requires two confirmations to save a missing-evidence case locally", async () => {
  await open();
  fill();
  await prepare();
  expect(
    screen.getByText("Original provider bill coverage is not verified."),
  ).toBeVisible();
  expect(
    screen.getByText(/Local review · QuickBooks verification pending/),
  ).toBeVisible();
  const save = screen.getByRole("button", {
    name: "Save reviewed accounting case",
  });
  expect(save).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the selected returns/ }),
  );
  expect(save).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I understand saving this case/ }),
  );
  fireEvent.click(save);
  expect(
    await screen.findByText(/Inventory accounting case saved/),
  ).toBeVisible();
  expect(state.operation).toHaveBeenCalledWith(path, "POST", {
    requestKey: expect.any(String),
    choice: preview.choice,
    fingerprint: preview.fingerprint,
    confirmNoFinancialPosting: true,
  });
  expect(
    state.operation.mock.calls.every(([url]) => url.startsWith(path)),
  ).toBe(true);
});
it("supports multiple exact return identities and invalidates the review when the job changes", async () => {
  await open();
  fill();
  expect(
    screen.queryByRole("checkbox", { name: /other-return/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /Return return-b/ }));
  preview.choice.returnIds = ["return-a", "return-b"];
  await prepare();
  confirm();
  expect(state.operation).toHaveBeenCalledWith(
    `${path}/preview`,
    "POST",
    preview.choice,
  );
  fireEvent.change(screen.getByLabelText("Job for returned material"), {
    target: { value: "job-b" },
  });
  expect(
    screen.queryByLabelText("Reviewed inventory accounting case"),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: /other-return/ }),
  ).not.toBeChecked();
});
it("locks an unknown save outcome to the identical request and UUID", async () => {
  await open();
  fill();
  await prepare();
  confirm();
  const implementation = state.operation.getMockImplementation()!;
  let failures = 0;
  state.operation.mockImplementation(async (...args) => {
    if (args[0] === path && failures < 2) {
      failures += 1;
      throw failures === 1
        ? new Error("Lost response")
        : Object.assign(new Error("Sign in again"), {
            name: "ApiError",
            status: 401,
          });
    }
    return implementation(...args);
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save reviewed accounting case" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "outcome is unknown",
  );
  expect(screen.getByLabelText("Accounting review note")).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry same case approval" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "outcome is unknown",
  );
  expect(screen.getByLabelText("Accounting review note")).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry same case approval" }),
  );
  await screen.findByText(/Inventory accounting case saved/);
  const writes = state.operation.mock.calls.filter(([url]) => url === path);
  expect(writes).toHaveLength(3);
  expect(writes[0]).toEqual(writes[1]);
  expect(writes[0]).toEqual(writes[2]);
});
it("rejects a preview for another source choice or unscoped ready plan", async () => {
  await open();
  fill();
  preview.plan = structuredClone(ready);
  fireEvent.click(
    screen.getByRole("button", { name: "Preview inventory accounting case" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "scope or evidence changed",
  );
  expect(
    screen.queryByRole("button", { name: "Save reviewed accounting case" }),
  ).not.toBeInTheDocument();
  preview.plan = structuredClone(manual);
  preview.choice.productId = "other";
  fireEvent.click(
    screen.getByRole("button", { name: "Preview inventory accounting case" }),
  );
  await waitFor(() =>
    expect(
      state.operation.mock.calls.filter(([url]) => url.endsWith("/preview")),
    ).toHaveLength(2),
  );
  expect(
    screen.queryByLabelText("Reviewed inventory accounting case"),
  ).not.toBeInTheDocument();
});
it("shows supported exact quantity plans as operator evidence without a provider submit action", async () => {
  preview.plan = structuredClone(ready);
  preview.company = {
    connectionId: "connection",
    realmId: "123",
    environment: "sandbox",
    companyName: "Sandbox",
  };
  await open();
  fill();
  await prepare();
  expect(
    screen.getByText(/Supported stock quantity difference: 2.000001/),
  ).toBeVisible();
  expect(screen.getByText(/review does not post to QuickBooks/)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /post to QuickBooks/i }),
  ).not.toBeInTheDocument();
  expect(
    state.operation.mock.calls.filter(([, method]) => method === "POST"),
  ).toHaveLength(1);
});
it("retries operator follow-up with the same immutable update after a lost response", async () => {
  options.cases = [saved];
  await open();
  fireEvent.change(screen.getByLabelText("Operator follow-up note"), {
    target: { value: "Supplier original requested for review" },
  });
  const implementation = state.operation.getMockImplementation()!;
  let failures = 0;
  state.operation.mockImplementation(async (...args) => {
    if (args[0].endsWith("/notes") && failures < 2) {
      failures += 1;
      throw failures === 1
        ? new Error("Lost response")
        : Object.assign(new Error("Exit preview"), {
            name: "ApiError",
            status: 403,
          });
    }
    return implementation(...args);
  });
  fireEvent.click(screen.getByRole("button", { name: "Save operator note" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "saved result is unknown",
  );
  expect(screen.getByLabelText("Operator follow-up note")).toBeDisabled();
  const retry = screen.getByRole("button", { name: "Retry same case update" });
  expect(retry).toBeEnabled();
  fireEvent.click(retry);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "saved result is unknown",
  );
  expect(screen.getByLabelText("Operator follow-up note")).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry same case update" }),
  );
  await waitFor(() =>
    expect(
      state.operation.mock.calls.filter(([url]) => url.endsWith("/notes")),
    ).toHaveLength(3),
  );
  const writes = state.operation.mock.calls.filter(([url]) =>
    url.endsWith("/notes"),
  );
  expect(writes[0]).toEqual(writes[1]);
  expect(writes[0]).toEqual(writes[2]);
});
it("requires an existing adjustment ID, exact case-reference confirmation and note before read-only verification", async () => {
  saved.kind = "return_quantity_plan";
  saved.plan = structuredClone(ready);
  saved.company = {
    connectionId: "connection",
    realmId: "123",
    environment: "sandbox",
    companyName: "Sandbox",
  };
  options.cases = [saved];
  await open();
  expect(screen.getAllByText(/WORKS-CASE-000001/).length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText("Existing QuickBooks adjustment ID"), {
    target: { value: "000123" },
  });
  fireEvent.change(screen.getByLabelText("Adjustment verification note"), {
    target: { value: "Reviewed existing adjustment and quantity" },
  });
  const button = screen.getByRole("button", {
    name: "Verify existing adjustment",
  });
  expect(button).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /reviewed the existing adjustment/ }),
  );
  fireEvent.click(button);
  await waitFor(() =>
    expect(state.operation).toHaveBeenCalledWith(
      `${path}/case-a/verify-adjustment`,
      "POST",
      {
        requestKey: expect.any(String),
        note: "Reviewed existing adjustment and quantity",
        adjustmentId: "000123",
      },
    ),
  );
  expect(
    state.operation.mock.calls.filter(([url]) => url.includes("/approve")),
  ).toHaveLength(0);
});
it.each([true, false])(
  "separates a verified external document from its observed quantity match=%s",
  async (matchesCurrentWorks) => {
    saved.kind = "return_quantity_plan";
    saved.plan = structuredClone(ready);
    saved.company = {
      connectionId: "connection",
      realmId: "123",
      environment: "sandbox",
      companyName: "Sandbox",
    };
    saved.events = [
      {
        id: "verified",
        kind: "external_adjustment_verified",
        adjustmentId: "00123",
        note: "Original adjustment document checked",
        createdAt: "2026-11-23T13:00:00Z",
        balanceObservation: {
          worksQuantity: "3.300001",
          quickBooksQuantity: matchesCurrentWorks ? "3.300001" : "2.000001",
          matchesCurrentWorks,
          matchesSavedTarget: false,
          observedAt: "2026-11-23T12:59:59Z",
        },
      },
    ];
    options.cases = [saved];
    await open();
    expect(
      screen.getByText(
        /External adjustment document verified · QuickBooks ID 00123/,
      ),
    ).toBeVisible();
    const observation = matchesCurrentWorks
      ? /Observed quantities match/
      : /Observed quantities differ; review current stock/;
    expect(screen.getByText(observation)).toHaveTextContent("Works 3.300001");
    expect(screen.getByText(observation)).toHaveTextContent(
      `QuickBooks ${saved.events[0].balanceObservation!.quickBooksQuantity}`,
    );
    expect(screen.getByText(observation)).toHaveTextContent(
      "Observed 2026-11-23T12:59:59Z",
    );
    expect(
      screen.getByText(/differed from the saved case target/),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Verify existing adjustment" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/has not been posted/)).not.toBeInTheDocument();
  },
);
it("does not imply a stock match when an older verified document has no balance observation", async () => {
  saved.events = [
    {
      id: "old-verification",
      kind: "external_adjustment_verified",
      adjustmentId: "00081",
      note: "Historical document verified",
      createdAt: "2026-11-23T13:00:00Z",
    },
  ];
  options.cases = [saved];
  await open();
  expect(
    screen.getByText(/External adjustment document verified/),
  ).toBeVisible();
  expect(
    screen.getByText(/No stock balance observation was retained/),
  ).toBeVisible();
  expect(
    screen.queryByText(/Observed quantities match/),
  ).not.toBeInTheDocument();
});
it("stops after role preview replaces a pending owner workspace", async () => {
  let done!: (result: InventoryAccountingOptions) => void;
  state.operation.mockReturnValue(
    new Promise<InventoryAccountingOptions>((resolve) => {
      done = resolve;
    }),
  );
  const view = render(<InventoryAccountingCases productId="product-a" />);
  state.user = {
    id: "owner",
    role: "operations",
    actualRole: "owner",
    previewRole: "operations",
  };
  view.rerender(<InventoryAccountingCases productId="product-a" />);
  done(options);
  await waitFor(() =>
    expect(screen.getByText(/actual owner outside role preview/)).toBeVisible(),
  );
  expect(
    screen.queryByLabelText("Job for returned material"),
  ).not.toBeInTheDocument();
  expect(state.operation).toHaveBeenCalledTimes(1);
});
