import { createHash } from "node:crypto";
import { workspaceEnvironment } from "@workspace/db/workspace";
import { z } from "zod";

export const stockAdjustmentEntity = "stock_return_adjustment";
const id = z.string().regex(/^\d{1,30}$/);
const localId = z.string().min(1).max(200);
const reference = z.object({ value: id });
const quantityScale = 1_000_000;

export function quantityUnits(value: unknown) {
  if (typeof value !== "number") return null;
  const units = Math.round(value * quantityScale);
  return Number.isSafeInteger(units) && units / quantityScale === value
    ? units
    : null;
}

export function quantityFromUnits(units: number) {
  return units / quantityScale;
}

type JobStockMovement = {
  id: string;
  kind: string;
  quantity: number;
  costAllocations?: Array<{
    source: string;
    sourceMovementId: string;
    quantity: number;
    unitCost: string;
  }> | null;
};

export function stockReturnIssueSources(
  movements: JobStockMovement[],
  returned: { id: string; returnOfMovementId: string; quantity: number },
) {
  const issues = movements.filter((movement) => movement.kind === "consume");
  const linked = issues.find(
    (movement) => movement.id === returned.returnOfMovementId,
  );
  const returnedUnits = quantityUnits(returned.quantity);
  const linkedUnits = linked ? quantityUnits(linked.quantity) : null;
  if (
    linkedUnits === null ||
    returnedUnits === null ||
    returnedUnits <= 0 ||
    returnedUnits > -linkedUnits ||
    movements.some(
      (movement) => movement.kind === "return" && movement.id !== returned.id,
    )
  )
    throw new Error(
      "Choose one returned quantity tied to a job issue. Review jobs with multiple returns in QuickBooks.",
    );

  const sources = new Map<string, { issuedUnits: number; unitCost: number }>();
  let issuedUnits = 0;
  for (const issue of issues) {
    const pending = quantityUnits(-issue.quantity);
    let allocated = 0;
    for (const allocation of issue.costAllocations ?? []) {
      const units = quantityUnits(allocation.quantity);
      const rate = Number(allocation.unitCost);
      const price = quantityUnits(rate);
      const source = sources.get(allocation.sourceMovementId);
      if (
        allocation.source !== "purchase_order" ||
        !allocation.sourceMovementId ||
        units === null ||
        units <= 0 ||
        price === null ||
        price < 0 ||
        (source && source.unitCost !== rate)
      )
        throw new Error(
          "Every job issue for this SKU must trace to purchase receipt stock at a verified acquisition price.",
        );
      sources.set(allocation.sourceMovementId, {
        unitCost: rate,
        issuedUnits: (source?.issuedUnits ?? 0) + units,
      });
      allocated += units;
    }
    if (pending === null || pending <= 0 || allocated !== pending)
      throw new Error(
        "Every job issue for this SKU must have an exact quantity of purchase receipt stock.",
      );
    issuedUnits += pending;
  }
  if (!Number.isSafeInteger(issuedUnits))
    throw new Error(
      "The issued quantity is outside the supported stock range.",
    );
  return { issued: quantityFromUnits(issuedUnits), sources };
}

export function matchesReceiptPrices(
  receipts: Array<{ quantity: number; unitCost: number }>,
  bill: Array<{ quantity: number; unitCost: number }>,
) {
  const byRate = (lines: Array<{ quantity: number; unitCost: number }>) => {
    const totals = new Map<number, number>();
    for (const line of lines) {
      const quantity = quantityUnits(line.quantity),
        rate = quantityUnits(line.unitCost);
      if (quantity === null || quantity <= 0 || rate === null || rate < 0)
        return null;
      const total = (totals.get(rate) ?? 0) + quantity;
      if (!Number.isSafeInteger(total)) return null;
      totals.set(rate, total);
    }
    return totals;
  };
  const expected = byRate(receipts),
    observed = byRate(bill);
  return (
    !!expected?.size &&
    !!observed &&
    expected.size === observed.size &&
    [...expected].every(([rate, quantity]) => observed.get(rate) === quantity)
  );
}

export function stockReceiptCoverage(
  sources: ReturnType<typeof stockReturnIssueSources>["sources"],
  receipts: Array<{ movementId: string; quantity: number; unitCost: number }>,
) {
  const unverified = new Set(sources.keys());
  let total = 0;
  for (const receipt of receipts) {
    const quantity = quantityUnits(receipt.quantity);
    const rate = quantityUnits(receipt.unitCost);
    const source = sources.get(receipt.movementId);
    if (
      quantity === null ||
      quantity <= 0 ||
      rate === null ||
      rate < 0 ||
      (source &&
        (source.issuedUnits > quantity ||
          quantityUnits(source.unitCost) !== rate))
    )
      throw new Error(
        "An accepted receipt quantity or acquisition price does not match the recorded stock.",
      );
    unverified.delete(receipt.movementId);
    total += quantity;
  }
  if (unverified.size || !Number.isSafeInteger(total) || total <= 0)
    throw new Error(
      "Every issue must trace to accepted receipt stock from this purchase order.",
    );
  return { received: quantityFromUnits(total), receivedLines: receipts };
}

export const inventoryItem = z.object({
  Id: id,
  Active: z.literal(true),
  Type: z.literal("Inventory"),
  TrackQtyOnHand: z.literal(true),
  QtyOnHand: z.number().refine((quantity) => quantityUnits(quantity) !== null),
  InvStartDate: z.string().date().optional(),
  Name: z.string().optional(),
  Sku: z.string().optional(),
});

export const adjustmentInput = z
  .object({
    productId: localId,
    returnId: localId,
    invoiceId: localId,
    billId: localId,
    accountId: id,
    date: z.string().date(),
    connectionId: localId,
  })
  .strict();
export type AdjustmentInput = z.infer<typeof adjustmentInput>;
export const approvalFingerprint = z.string().regex(/^[a-f\d]{64}$/);
type Company = {
  id: string;
  environment: string;
  realmId: string;
  status: string;
};
export type AdjustmentProvider = {
  request: (path: string, init?: RequestInit) => Promise<unknown>;
  query: (sql: string) => Promise<unknown>;
};

export function stockAdjustmentsAvailable(
  company: Company,
  env = workspaceEnvironment(),
) {
  const runtime = env.QUICKBOOKS_ENVIRONMENT ?? "sandbox";
  if (
    company.status !== "connected" ||
    runtime !== company.environment ||
    env.DEMO_MODE === "true"
  )
    return false;
  return (
    runtime === "sandbox" ||
    (runtime === "production" &&
      env.QUICKBOOKS_PRODUCTION_INVENTORY_ADJUSTMENTS_ENABLED === "true" &&
      company.realmId ===
        env.QUICKBOOKS_PRODUCTION_INVENTORY_ADJUSTMENTS_REALM_ID)
  );
}

export async function verifyAdjustmentCompany(
  company: Company,
  request: AdjustmentProvider["request"],
  accountId: string,
) {
  const [companyResponse, accountResponse] = await Promise.all([
    request(`/companyinfo/${company.realmId}`),
    request(`/account/${accountId}`),
  ]);
  const parsed = z
    .object({
      CompanyInfo: z.object({
        Country: z.enum(["US", "USA", "United States"]),
        NameValue: z.array(z.object({ Name: z.string(), Value: z.unknown() })),
      }),
    })
    .safeParse(companyResponse);
  const offering =
    parsed.success &&
    parsed.data.CompanyInfo.NameValue.find(({ Name }) => Name === "OfferingSku")
      ?.Value;
  if (
    offering !== "QuickBooks Online Plus" &&
    offering !== "QuickBooks Online Advanced"
  )
    throw new Error(
      "Inventory adjustments require a verified US QuickBooks Online Plus or Advanced company.",
    );
  const account = z
    .object({
      Account: z.object({
        Id: id,
        Name: z.string().min(1),
        Active: z.literal(true),
        AccountType: z.enum(["Cost of Goods Sold", "Expense", "Other Expense"]),
      }),
    })
    .safeParse(accountResponse);
  if (!account.success || account.data.Account.Id !== accountId)
    throw new Error(
      "Choose an active QuickBooks expense or cost of goods sold account for the return adjustment.",
    );
  return { offering, account: account.data.Account };
}

const adjustmentLine = z.object({
  DetailType: z.literal("ItemAdjustmentLineDetail"),
  ItemAdjustmentLineDetail: z.object({
    ItemRef: reference,
    QtyDiff: z
      .number()
      .refine((quantity) => quantityUnits(quantity) !== null && quantity !== 0),
  }),
});
export const adjustmentDocument = z.object({
  DocNumber: z.string().regex(/^CWAR[a-f\d]{16}$/),
  TxnDate: z.string().date(),
  PrivateNote: z.string(),
  AdjustAccountRef: reference,
  Line: z.tuple([adjustmentLine]),
});
type AdjustmentDocument = z.infer<typeof adjustmentDocument>;
export const approvedStockAdjustment = z.object({
  fingerprint: approvalFingerprint,
  requestId: z.string().regex(/^cwadj-[a-f\d]{44}$/),
  document: adjustmentDocument,
  before: z.number(),
  target: z.number(),
  choice: adjustmentInput,
});
export type ApprovedStockAdjustment = z.infer<typeof approvedStockAdjustment>;

export const stockFingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function prepareStockReturnAdjustment(
  company: Company,
  choice: AdjustmentInput,
  quantity: { before: number; target: number; returned: number },
  itemId: string,
  evidence: unknown,
) {
  const before = quantityUnits(quantity.before);
  const target = quantityUnits(quantity.target);
  const returned = quantityUnits(quantity.returned);
  if (
    before === null ||
    target === null ||
    returned === null ||
    returned <= 0 ||
    target - before !== returned
  )
    throw new Error(
      "The verified return must explain the entire difference between Catalyst and QuickBooks quantities.",
    );
  const key = stockFingerprint([
    company.environment,
    company.realmId,
    choice.returnId,
  ]);
  const requestId = `cwadj-${key.slice(0, 44)}`;
  const document = adjustmentDocument.parse({
    DocNumber: `CWAR${key.slice(0, 16)}`,
    TxnDate: choice.date,
    PrivateNote: `Catalyst Works stock return ${requestId}`,
    AdjustAccountRef: { value: choice.accountId },
    Line: [
      {
        DetailType: "ItemAdjustmentLineDetail",
        ItemAdjustmentLineDetail: {
          ItemRef: { value: itemId },
          QtyDiff: quantityFromUnits(returned),
        },
      },
    ],
  });
  return {
    choice,
    before: quantity.before,
    target: quantity.target,
    document,
    requestId,
    fingerprint: stockFingerprint([
      company.id,
      company.environment,
      company.realmId,
      choice,
      evidence,
      quantity,
      document,
    ]),
  };
}

export async function readAdjustmentItem(
  itemId: string,
  request: AdjustmentProvider["request"],
) {
  const result = z
    .object({ Item: inventoryItem })
    .safeParse(await request(`/item/${itemId}`));
  if (!result.success || result.data.Item.Id !== itemId)
    throw new Error(
      "The mapped QuickBooks inventory item is inactive or its stock balance could not be verified.",
    );
  return result.data.Item;
}

const remoteAdjustment = adjustmentDocument.extend({
  Id: id,
  Line: z.tuple([
    adjustmentLine.extend({
      DetailType: z
        .literal("ItemAdjustmentLineDetail")
        .default("ItemAdjustmentLineDetail"),
    }),
  ]),
});

export function matchesAdjustment(expected: AdjustmentDocument, value: unknown) {
  const parsed = remoteAdjustment.safeParse(value);
  if (!parsed.success) return undefined;
  const { Id, ...actual } = parsed.data;
  return JSON.stringify(actual) === JSON.stringify(expected) ? Id : undefined;
}

const transactionReport = z.object({
  Header: z.object({ ReportName: z.literal("TransactionList") }),
  Columns: z.object({
    Column: z.array(z.object({ ColType: z.string().optional() })),
  }),
  Rows: z.object({ Row: z.array(z.unknown()).default([]) }),
});
const reportRow = z.object({
  ColData: z
    .array(z.object({ value: z.string(), id: z.string().optional() }))
    .optional(),
  Rows: z.object({ Row: z.array(z.unknown()) }).optional(),
});

async function findAdjustmentByReference(
  document: AdjustmentDocument,
  request: AdjustmentProvider["request"],
) {
  const params = new URLSearchParams({
    start_date: document.TxnDate,
    end_date: document.TxnDate,
    columns: "tx_date,txn_type,doc_num",
  });
  const parsed = transactionReport.safeParse(
    await request(`/reports/TransactionList?${params}`).catch(() => undefined),
  );
  if (!parsed.success) return undefined;
  const columns = parsed.data.Columns.Column.map((column) => column.ColType);
  const reference = columns.indexOf("doc_num"),
    transaction = columns.indexOf("txn_type"),
    date = columns.indexOf("tx_date");
  if (reference < 0 || transaction < 0 || date < 0) return undefined;
  const results = new Set<string>();
  const inspect = (rows: unknown[]) => {
    for (const raw of rows) {
      const row = reportRow.safeParse(raw);
      if (!row.success) continue;
      const data = row.data.ColData;
      if (
        data?.[reference]?.value === document.DocNumber &&
        data[date]?.value === document.TxnDate &&
        ["inventoryadjustment", "inventoryquantityadjustment"].includes(
          data[transaction]?.value.toLowerCase().replaceAll(" ", "") ?? "",
        )
      ) {
        const possibleId = id.safeParse(data[transaction].id);
        if (possibleId.success) results.add(possibleId.data);
      }
      if (row.data.Rows) inspect(row.data.Rows.Row);
    }
  };
  inspect(parsed.data.Rows.Row);
  if (results.size > 1)
    throw new Error(
      "QuickBooks has multiple adjustments with this review reference. Verify the intended adjustment in QuickBooks.",
    );
  return [...results][0];
}

export async function exportStockReturnAdjustment(
  approved: ApprovedStockAdjustment,
  provider: AdjustmentProvider,
  options: {
    verifyCurrent: () => Promise<void>;
    markSubmitting: () => Promise<void>;
    recordAdjustmentId: (id: string) => Promise<void>;
    allowCreate: boolean;
    knownAdjustmentId?: string;
  },
) {
  const { document, requestId, before, target } = approved;
  const itemId = document.Line[0].ItemAdjustmentLineDetail.ItemRef.value;
  const recovered = !options.allowCreate;
  let adjustmentId = options.knownAdjustmentId;
  if (recovered) {
    if (!adjustmentId)
      adjustmentId = await findAdjustmentByReference(
        document,
        provider.request,
      );
    if (!adjustmentId)
      throw new Error(
        `The earlier submission was unconfirmed. Find reference ${document.DocNumber} in QuickBooks and verify its adjustment ID here.`,
      );
  } else {
    await options.verifyCurrent();
    const item = await readAdjustmentItem(itemId, provider.request);
    if (quantityUnits(item.QtyOnHand) !== quantityUnits(before))
      throw new Error(
        "The QuickBooks stock quantity changed after review. No adjustment was submitted.",
      );
    await options.markSubmitting();
    const posted = z
      .object({ InventoryAdjustment: z.object({ Id: id }) })
      .safeParse(
        await provider.request(`/inventoryadjustment?requestid=${requestId}`, {
          method: "POST",
          body: JSON.stringify(document),
        }),
      );
    if (!posted.success)
      throw new Error(
        "QuickBooks did not confirm the adjustment ID. Reconcile the reference before retrying.",
      );
    adjustmentId = posted.data.InventoryAdjustment.Id;
    await options.recordAdjustmentId(adjustmentId);
  }
  const remote = z
    .object({ InventoryAdjustment: z.unknown() })
    .safeParse(await provider.request(`/inventoryadjustment/${adjustmentId}`));
  if (
    !remote.success ||
    matchesAdjustment(document, remote.data.InventoryAdjustment) !==
      adjustmentId
  )
    throw new Error(
      "The QuickBooks adjustment differs from the approved details. Review it in QuickBooks before retrying.",
    );
  const observed = (await readAdjustmentItem(itemId, provider.request))
    .QtyOnHand;
  return {
    adjustmentId,
    recovered,
    observed,
    target,
    balanceMatches: quantityUnits(observed) === quantityUnits(target),
  };
}
