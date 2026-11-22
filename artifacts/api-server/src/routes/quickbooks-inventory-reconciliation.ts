import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import {
  db,
  inventoryMovementsTable,
  inventoryTransfersTable,
  invoicesTable,
  productsTable,
  purchaseOrderLinesTable,
  purchaseOrdersTable,
  purchaseReceiptLinesTable,
  purchaseReceiptsTable,
  quickbooksEntityMappingsTable,
  quickbooksSyncJobsTable,
} from "@workspace/db";
import { audit } from "../lib/auth";
import { domainRoute, id, parse } from "../lib/domain-http";
import { lockStockProduct, roundStock } from "../lib/inventory-stock";
import { DomainError } from "../lib/operations-rules";
import { getConnection, qboQuery, qboRequest } from "../lib/quickbooks";
import { loadQuickBooksCatalogEntity } from "../lib/quickbooks-catalog";
import {
  adjustmentInput,
  approvalFingerprint,
  approvedStockAdjustment,
  exportStockReturnAdjustment,
  inventoryItem,
  matchesReceiptPrices,
  prepareStockReturnAdjustment,
  quantityUnits,
  readAdjustmentItem,
  stockAdjustmentEntity,
  stockAdjustmentsAvailable,
  stockReceiptCoverage,
  stockReturnIssueSources,
  verifyAdjustmentCompany,
  type AdjustmentInput,
} from "../lib/quickbooks-inventory-reconciliation";
import {
  productionStockItemEntity,
  sandboxStockItemEntity,
} from "../lib/quickbooks-stock-item";
import {
  matchesPostedBill,
  vendorBillEntity,
  type PreparedBill,
} from "../lib/vendor-bill";
import { requireOwner } from "../middlewares/auth";

const router = Router();
const base = "/quickbooks/stock-reconciliation";
const products = productsTable,
  transfers = inventoryTransfersTable,
  mappings = quickbooksEntityMappingsTable;
const movements = inventoryMovementsTable,
  queue = quickbooksSyncJobsTable;
type Company = NonNullable<Awaited<ReturnType<typeof getConnection>>>;
type Reader = Pick<typeof db, "select">;
const providerId = z.string().regex(/^\d{1,30}$/);
const officeDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const asDate = (value: string) => officeDate.format(new Date(value));
const sameQuantity = (left: number, right: number) =>
  quantityUnits(left) !== null && quantityUnits(left) === quantityUnits(right);

async function companyContext(connectionId?: string) {
  const company = await getConnection();
  if (
    company?.status !== "connected" ||
    (connectionId && connectionId !== company.id)
  )
    throw new DomainError(
      409,
      "Connect and confirm the intended QuickBooks company.",
    );
  return company;
}

function providerFor(company: Company) {
  return {
    request: (path: string, init?: RequestInit) =>
      qboRequest(path, init, company.id),
    query: (statement: string) => qboQuery(statement, company.id),
  };
}

function realmLinks(company: Company) {
  return and(
    eq(mappings.status, "linked"),
    eq(mappings.realmId, company.realmId),
    eq(mappings.environment, company.environment),
  );
}

function sharedItemMappings(company: Company, reader: Reader, itemId?: string) {
  return reader
    .select({ itemId: mappings.quickbooksId })
    .from(mappings)
    .where(
      and(
        realmLinks(company),
        eq(mappings.entityType, "item"),
        itemId ? eq(mappings.quickbooksId, itemId) : undefined,
      ),
    )
    .groupBy(mappings.quickbooksId)
    .having(sql`count(*) > 1`);
}

async function localBalances(
  company: Company,
  reader: Reader,
  productId?: string,
) {
  const filter = productId ? eq(products.id, productId) : undefined;
  const local = await reader
    .select({
      product: products,
      itemId: mappings.quickbooksId,
      inTransit: sql<number>`coalesce((select sum(${transfers.quantity}) from ${transfers} where ${transfers.productId} = ${products.id} and ${transfers.status} = 'In transit'), 0)::double precision`,
    })
    .from(products)
    .leftJoin(
      mappings,
      and(
        eq(mappings.localId, products.id),
        eq(mappings.entityType, "item"),
        realmLinks(company),
      ),
    )
    .where(
      and(
        filter,
        eq(products.active, true),
        eq(products.inventoryType, "Inventory"),
      ),
    )
    .orderBy(products.sku, products.id);
  return local.map(({ product, itemId, inTransit }) => ({
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.unit,
    itemId,
    warehouseOnHand: product.quantityOnHand,
    inTransit: roundStock(inTransit),
    localOnHand: roundStock(product.quantityOnHand + inTransit),
  }));
}

router.get(
  base,
  requireOwner,
  domainRoute(async (_req, res) => {
    const company = await companyContext();
    const provider = providerFor(company);
    const [local, catalog, shared] = await Promise.all([
      localBalances(company, db),
      loadQuickBooksCatalogEntity("Item", provider.query),
      sharedItemMappings(company, db),
    ]);
    const byId = new Map(catalog.map((item) => [item.Id, item]));
    const sharedIds = new Set(shared.map((link) => link.itemId));
    const rows = local.map((row) => {
      const parsed = inventoryItem.safeParse(
        row.itemId && !sharedIds.has(row.itemId)
          ? byId.get(row.itemId)
          : undefined,
      );
      const quickBooksOnHand = parsed.success ? parsed.data.QtyOnHand : null;
      return {
        ...row,
        quickBooksOnHand,
        difference:
          quickBooksOnHand === null
            ? null
            : roundStock(row.localOnHand - quickBooksOnHand),
        status: !row.itemId
          ? "unmapped"
          : quickBooksOnHand === null
            ? "unverified"
            : sameQuantity(row.localOnHand, quickBooksOnHand)
              ? "matched"
              : "different",
      };
    });
    res.json({
      rows,
      connectionId: company.id,
      realmId: company.realmId,
      company: company.companyName || company.realmId,
      environment: company.environment,
      adjustmentEnabled: stockAdjustmentsAvailable(company),
      observedAt: new Date().toISOString(),
    });
  }),
);

function postedBills(company: Company) {
  return and(
    eq(queue.entityType, vendorBillEntity),
    eq(queue.status, "completed"),
    sql`${queue.payload}->>'mode' = ${company.environment}`,
    sql`${queue.payload}->>'realmId' = ${company.realmId}`,
  );
}

function preparedBill(row: typeof queue.$inferSelect | undefined) {
  if (!row) return undefined;
  const parsed = z
    .object({
      postedId: providerId,
      supplier: z.string(),
      quickBooksBill: z
        .object({
          DocNumber: z.string(),
          Line: z.array(z.object({ DetailType: z.string() }).passthrough()),
        })
        .passthrough(),
    })
    .safeParse(row.payload);
  return parsed.success
    ? {
        ...parsed.data,
        quickBooksBill: parsed.data.quickBooksBill as PreparedBill,
      }
    : undefined;
}

function billItems(document: PreparedBill, itemId: string) {
  return document.Line.flatMap((line) =>
    line.DetailType === "ItemBasedExpenseLineDetail" &&
    line.ItemBasedExpenseLineDetail?.ItemRef.value === itemId
      ? [line.ItemBasedExpenseLineDetail]
      : [],
  );
}

router.get(
  `${base}/:id`,
  requireOwner,
  domainRoute(async (req, res) => {
    const company = await companyContext();
    const productId = id(req);
    const [local] = await localBalances(company, db, productId);
    if (!local?.itemId || !stockAdjustmentsAvailable(company))
      throw new DomainError(
        409,
        "Stock adjustment review is unavailable for this item.",
      );
    const [returns, bills, attempts, accounts] = await Promise.all([
      db
        .select({
          id: movements.id,
          jobId: movements.jobId,
          quantity: movements.quantity,
          reason: movements.reason,
          createdAt: movements.createdAt,
        })
        .from(movements)
        .where(
          and(
            eq(movements.productId, productId),
            eq(movements.kind, "return"),
            sql`${movements.returnOfMovementId} is not null`,
          ),
        )
        .orderBy(desc(movements.createdAt))
        .limit(100),
      db
        .select()
        .from(queue)
        .where(postedBills(company))
        .orderBy(desc(queue.completedAt))
        .limit(150),
      db
        .select()
        .from(queue)
        .where(
          and(
            eq(queue.entityType, stockAdjustmentEntity),
            sql`${queue.payload}->'choice'->>'productId' = ${productId}`,
            sql`${queue.payload}->'choice'->>'connectionId' = ${company.id}`,
          ),
        )
        .orderBy(desc(queue.createdAt))
        .limit(30),
      loadQuickBooksCatalogEntity("Account", providerFor(company).query),
    ]);
    const invoices = await db
      .select({
        id: invoicesTable.id,
        jobId: invoicesTable.jobId,
        number: invoicesTable.invoiceNumber,
        jobNumber: invoicesTable.jobNumber,
      })
      .from(invoicesTable)
      .innerJoin(
        mappings,
        and(
          eq(mappings.localId, invoicesTable.id),
          eq(mappings.entityType, "invoice"),
          realmLinks(company),
        ),
      )
      .where(
        inArray(invoicesTable.jobId, [
          ...new Set(
            returns.flatMap((entry) => (entry.jobId ? [entry.jobId] : [])),
          ),
        ]),
      );
    res.json({
      returns,
      invoices,
      bills: bills.flatMap((bill) => {
        const approved = preparedBill(bill);
        return approved &&
          billItems(approved.quickBooksBill, local.itemId!).length
          ? [
              {
                id: bill.id,
                number: approved.quickBooksBill.DocNumber,
                supplier: approved.supplier,
              },
            ]
          : [];
      }),
      accounts: accounts.flatMap((account) => {
        const parsed = z
          .object({
            Id: providerId,
            Name: z.string(),
            Active: z.literal(true),
            AccountType: z.enum([
              "Cost of Goods Sold",
              "Expense",
              "Other Expense",
            ]),
          })
          .safeParse(account);
        return parsed.success
          ? [
              {
                id: parsed.data.Id,
                name: parsed.data.Name,
                type: parsed.data.AccountType,
              },
            ]
          : [];
      }),
      attempts: attempts.flatMap((attempt) => {
        const approval = approvedStockAdjustment.safeParse(attempt.payload);
        return approval.success
          ? [
              {
                status: attempt.status,
                lastError: attempt.lastError,
                result: attempt.payload.result,
                submitted: attempt.payload.submitted === true,
                choice: approval.data.choice,
                fingerprint: approval.data.fingerprint,
                reference: approval.data.document.DocNumber,
                knownAdjustmentId: providerId.safeParse(
                  attempt.payload.postedId,
                ).data,
              },
            ]
          : [];
      }),
    });
  }),
);

const invoiceEvidence = z.object({
  Invoice: z.object({
    Id: providerId,
    DocNumber: z.string(),
    TxnDate: z.string().date(),
    PrivateNote: z.string().optional(),
    CustomerRef: z.object({ value: providerId }),
    LinkedTxn: z.array(z.object({ TxnType: z.string() })).optional(),
    Line: z.array(
      z.object({
        DetailType: z.string(),
        SalesItemLineDetail: z
          .object({
            ItemRef: z.object({ value: z.string() }),
            Qty: z.number().optional(),
            UnitPrice: z.number().optional(),
          })
          .optional(),
      }),
    ),
  }),
});
const openingEvidence = z.object({
  realmId: z.string(),
  environment: z.string(),
  document: z.object({
    QtyOnHand: z.literal(0),
    InvStartDate: z.string().date(),
  }),
  result: z.object({
    itemId: providerId,
    reconciledExisting: z.literal(false),
  }),
});

async function prepare(company: Company, choice: AdjustmentInput) {
  if (!stockAdjustmentsAvailable(company))
    throw new Error(
      "Stock adjustment posting is disabled for this QuickBooks company.",
    );
  const provider = providerFor(company);
  const [local] = await localBalances(company, db, choice.productId);
  if (!local?.itemId || !providerId.safeParse(local.itemId).success)
    throw new Error(
      "Link this stocked SKU to an inventory item in the connected company.",
    );
  if ((await sharedItemMappings(company, db, local.itemId)).length)
    throw new Error(
      "More than one Catalyst SKU links to this QuickBooks item. Reconcile its mappings before adjusting stock.",
    );
  const [opening] = await db
    .select()
    .from(queue)
    .where(
      and(
        eq(queue.localId, choice.productId),
        eq(queue.status, "completed"),
        eq(
          queue.entityType,
          company.environment === "sandbox"
            ? sandboxStockItemEntity
            : productionStockItemEntity,
        ),
        sql`${queue.payload}->>'realmId' = ${company.realmId}`,
      ),
    )
    .limit(1);
  const zero = openingEvidence.safeParse(opening?.payload);
  if (
    !zero.success ||
    zero.data.result.itemId !== local.itemId ||
    zero.data.environment !== company.environment
  )
    throw new Error(
      "Adjustments support stock items Catalyst created in this company with an explicit zero opening quantity.",
    );

  const [returned] = await db
    .select()
    .from(movements)
    .where(
      and(
        eq(movements.id, choice.returnId),
        eq(movements.productId, choice.productId),
        eq(movements.kind, "return"),
      ),
    );
  if (
    !returned?.jobId ||
    !returned.returnOfMovementId ||
    returned.quantity <= 0
  )
    throw new Error(
      "Choose a warehouse return tied to the original job issue.",
    );
  const jobMovements = await db
    .select()
    .from(movements)
    .where(
      and(
        eq(movements.productId, choice.productId),
        eq(movements.jobId, returned.jobId),
        inArray(movements.kind, ["consume", "return"]),
      ),
    );
  const { issued, sources } = stockReturnIssueSources(jobMovements, {
    ...returned,
    returnOfMovementId: returned.returnOfMovementId,
  });
  const orders = await db
    .selectDistinct({ id: purchaseReceiptsTable.orderId })
    .from(purchaseReceiptLinesTable)
    .innerJoin(
      purchaseReceiptsTable,
      eq(purchaseReceiptsTable.id, purchaseReceiptLinesTable.receiptId),
    )
    .where(inArray(purchaseReceiptLinesTable.movementId, [...sources.keys()]))
    .limit(2);
  if (orders.length !== 1)
    throw new Error(
      "Review issues sourced from multiple purchase orders or missing purchase receipts in QuickBooks.",
    );
  const receipts = await db
    .select({
      line: purchaseReceiptLinesTable,
      receipt: purchaseReceiptsTable,
      order: purchaseOrdersTable,
      product: purchaseOrderLinesTable,
      movement: movements,
    })
    .from(purchaseReceiptLinesTable)
    .innerJoin(
      purchaseReceiptsTable,
      eq(purchaseReceiptsTable.id, purchaseReceiptLinesTable.receiptId),
    )
    .innerJoin(
      purchaseOrdersTable,
      eq(purchaseOrdersTable.id, purchaseReceiptsTable.orderId),
    )
    .innerJoin(
      purchaseOrderLinesTable,
      eq(purchaseOrderLinesTable.id, purchaseReceiptLinesTable.lineId),
    )
    .innerJoin(
      movements,
      eq(movements.id, purchaseReceiptLinesTable.movementId),
    )
    .where(
      and(
        eq(purchaseReceiptsTable.orderId, orders[0].id),
        eq(purchaseOrderLinesTable.productId, choice.productId),
        gt(purchaseReceiptLinesTable.quantity, "0"),
      ),
    )
    .orderBy(purchaseReceiptsTable.receivedAt, purchaseReceiptLinesTable.id);
  const [receipt] = receipts;
  if (
    !receipt ||
    receipts.some(
      (entry) =>
        entry.product.orderId !== entry.order.id ||
        entry.product.unit !== local.unit ||
        entry.movement.productId !== choice.productId ||
        entry.movement.kind !== "receipt" ||
        !sameQuantity(entry.movement.quantity, Number(entry.line.quantity)) ||
        entry.movement.acquisitionUnitCost === null,
    )
  )
    throw new Error(
      "The accepted receipts on this purchase order must have the same stock units and verified receipt movements.",
    );
  const { received, receivedLines } = stockReceiptCoverage(
    sources,
    receipts.map((entry) => ({
      movementId: entry.movement.id,
      quantity: Number(entry.line.quantity),
      unitCost: Number(entry.movement.acquisitionUnitCost),
    })),
  );

  const [[billRow], [invoice], [customer]] = await Promise.all([
    db
      .select()
      .from(queue)
      .where(and(eq(queue.id, choice.billId), postedBills(company))),
    db
      .select({ source: invoicesTable, quickBooksId: mappings.quickbooksId })
      .from(invoicesTable)
      .innerJoin(
        mappings,
        and(
          eq(mappings.localId, invoicesTable.id),
          eq(mappings.entityType, "invoice"),
          realmLinks(company),
        ),
      )
      .where(
        and(
          eq(invoicesTable.id, choice.invoiceId),
          eq(invoicesTable.jobId, returned.jobId),
        ),
      ),
    db
      .select()
      .from(mappings)
      .where(
        and(
          eq(mappings.localId, returned.jobId),
          eq(mappings.entityType, "customer"),
          realmLinks(company),
        ),
      ),
  ]);
  const bill = preparedBill(billRow);
  if (
    !bill ||
    bill.supplier.trim().toLowerCase() !==
      receipt.order.supplier.trim().toLowerCase() ||
    !invoice ||
    !customer ||
    !providerId.safeParse(invoice.quickBooksId).success ||
    ["Credited", "Refunded", "Voided"].includes(invoice.source.status)
  )
    throw new Error(
      "Choose the posted supplier bill for the original receipt and an active QuickBooks invoice for the same job.",
    );
  const purchases = billItems(bill.quickBooksBill, local.itemId);
  if (
    !matchesReceiptPrices(
      receivedLines,
      purchases.map((line) => ({
        quantity: line.Qty,
        unitCost: line.UnitPrice,
      })),
    )
  )
    throw new Error(
      "The selected posted bill must match the exact item quantities and acquisition prices across all accepted receipts on this purchase order.",
    );
  const billed = invoice.source.lineItems.filter(
    (line) => line.productId === choice.productId,
  );
  if (
    !billed.length ||
    !sameQuantity(
      roundStock(billed.reduce((sum, line) => sum + line.quantity, 0)),
      issued,
    )
  )
    throw new Error(
      "The customer invoice must have billed the total issued quantity for this SKU.",
    );

  const [item, currentBill, responseInvoice, accounting] = await Promise.all([
    readAdjustmentItem(local.itemId, provider.request),
    provider.request(`/bill/${bill.postedId}`),
    provider.request(`/invoice/${invoice.quickBooksId}`),
    verifyAdjustmentCompany(company, provider.request, choice.accountId),
  ]);
  const remoteBill = z
    .object({ Bill: z.object({ Id: providerId }).passthrough() })
    .safeParse(currentBill);
  const remote = invoiceEvidence.safeParse(responseInvoice);
  const posted = remote.success ? remote.data.Invoice : undefined;
  const sale =
    posted?.Line.flatMap((line) =>
      line.DetailType === "SalesItemLineDetail" &&
      line.SalesItemLineDetail?.ItemRef.value === local.itemId
        ? [line.SalesItemLineDetail]
        : [],
    ) ?? [];
  const ratesAndQuantities = (
    lines: ReadonlyArray<{
      quantity: number | undefined;
      rate: number | undefined;
    }>,
  ) =>
    lines
      .map(({ quantity, rate }) =>
        JSON.stringify([quantityUnits(quantity), quantityUnits(rate)]),
      )
      .sort();
  const localLines = ratesAndQuantities(
    billed.map((line) => ({ quantity: line.quantity, rate: line.unitPrice })),
  );
  const remoteLines = ratesAndQuantities(
    sale.map((line) => ({ quantity: line.Qty, rate: line.UnitPrice })),
  );
  if (
    !remoteBill.success ||
    remoteBill.data.Bill.Id !== bill.postedId ||
    !matchesPostedBill(bill.quickBooksBill, remoteBill.data.Bill) ||
    posted?.Id !== invoice.quickBooksId ||
    posted.DocNumber !== invoice.source.invoiceNumber ||
    posted.CustomerRef.value !== customer.quickbooksId ||
    /^voided\b/i.test(posted.PrivateNote ?? "") ||
    posted.LinkedTxn?.some((txn) =>
      ["CreditMemo", "RefundReceipt"].includes(txn.TxnType),
    ) ||
    localLines.some((line) => line.includes("null")) ||
    JSON.stringify(localLines) !== JSON.stringify(remoteLines)
  )
    throw new Error(
      "QuickBooks must still contain the exact active bill and customer invoice item before this return can be adjusted.",
    );
  if (
    item.InvStartDate !== zero.data.document.InvStartDate ||
    choice.date <= item.InvStartDate ||
    choice.date < asDate(returned.createdAt) ||
    choice.date < posted.TxnDate ||
    choice.date < bill.quickBooksBill.TxnDate ||
    choice.date > asDate(new Date().toISOString())
  )
    throw new Error(
      "Use an open accounting date on or after the return and both transactions, after inventory started, and no later than today.",
    );
  const evidence = {
    receiptId: receipt.receipt.id,
    receiptReference: [
      ...new Set(
        receipts.map((entry) => entry.receipt.reference || entry.receipt.id),
      ),
    ].join(", "),
    orderNumber: String(receipt.order.number),
    received,
    purchaseReceipts: receipts.map((entry) => ({
      movementId: entry.movement.id,
      receiptId: entry.receipt.id,
      allocated: sources.get(entry.movement.id)?.issuedUnits ?? 0,
      quantity: entry.line.quantity,
      unitCost: entry.movement.acquisitionUnitCost,
    })),
    billId: bill.postedId,
    billNumber: bill.quickBooksBill.DocNumber,
    invoiceId: posted.Id,
    invoiceNumber: posted.DocNumber,
    jobNumber: invoice.source.jobNumber,
    issued,
    returned: returned.quantity,
    returnReason: returned.reason,
    local,
    itemId: item.Id,
    account: accounting.account,
    offering: accounting.offering,
  };
  const approved = prepareStockReturnAdjustment(
    company,
    choice,
    {
      before: item.QtyOnHand,
      target: local.localOnHand,
      returned: returned.quantity,
    },
    item.Id,
    evidence,
  );
  return { approved, evidence };
}

async function review(company: Company, choice: AdjustmentInput) {
  try {
    return await prepare(company, choice);
  } catch (error) {
    throw new DomainError(
      409,
      error instanceof Error
        ? error.message
        : "Could not verify the inventory return.",
    );
  }
}

router.post(
  `${base}/preview`,
  requireOwner,
  domainRoute(async (req, res) => {
    const choice = parse(adjustmentInput, req.body);
    res.json(await review(await companyContext(choice.connectionId), choice));
  }),
);

router.post(
  `${base}/approve`,
  requireOwner,
  domainRoute(async (req, res) => {
    const { choice, fingerprint, adjustmentId } = parse(
      z
        .object({
          choice: adjustmentInput,
          fingerprint: approvalFingerprint,
          adjustmentId: providerId.optional(),
        })
        .strict(),
      req.body,
    );
    const company = await companyContext(choice.connectionId);
    if (!stockAdjustmentsAvailable(company))
      throw new DomainError(
        409,
        "Stock adjustment posting is disabled for this company.",
      );
    const key = `stock-return:${company.environment}:${company.realmId}:${choice.returnId}`;
    const [prior] = await db
      .select()
      .from(queue)
      .where(eq(queue.idempotencyKey, key));
    const frozen =
      prior?.payload.submitted === true || prior?.status === "completed";
    if (adjustmentId && !frozen)
      throw new DomainError(
        409,
        "Enter a QuickBooks adjustment ID only to verify an earlier submission.",
      );
    const approval = frozen
      ? approvedStockAdjustment.parse(prior.payload)
      : (await review(company, choice)).approved;
    if (
      fingerprint !== approval.fingerprint ||
      JSON.stringify(choice) !== JSON.stringify(approval.choice)
    )
      throw new DomainError(
        409,
        "The approval no longer matches the verified return. Review the original adjustment first.",
      );
    const now = new Date().toISOString();
    const claimed = await db.transaction(async (tx) => {
      await lockStockProduct(tx, choice.productId);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
      const [initial] = await tx
        .select()
        .from(queue)
        .where(eq(queue.idempotencyKey, key))
        .for("update");
      if (
        initial &&
        (initial.payload.submitted || initial.status === "completed") &&
        initial.payload.fingerprint !== fingerprint
      )
        throw new DomainError(
          409,
          "The previous submission has different approved details. Review it in QuickBooks.",
        );
      if (initial?.status === "completed") return initial;
      if (
        initial?.status === "processing" &&
        initial.startedAt &&
        Date.now() - Date.parse(initial.startedAt) < 300_000
      )
        throw new DomainError(
          409,
          "Another attempt is already processing this adjustment.",
        );
      const existingId = providerId.safeParse(initial?.payload.postedId);
      const values = {
        payload: {
          ...approval,
          submitted: initial?.payload.submitted === true,
          ...(existingId.success ? { postedId: existingId.data } : {}),
        },
        status: "processing",
        approvedBy: req.auth!.userId,
        approvedAt: now,
        startedAt: now,
        updatedAt: now,
        lastError: null,
        attempts: (initial?.attempts ?? 0) + 1,
      };
      if (initial) {
        const [changed] = await tx
          .update(queue)
          .set(values)
          .where(eq(queue.id, initial.id))
          .returning();
        return changed;
      }
      const [created] = await tx
        .insert(queue)
        .values({
          ...values,
          id: randomUUID(),
          idempotencyKey: key,
          entityType: stockAdjustmentEntity,
          action: "create",
          localId: choice.returnId,
          createdAt: now,
        })
        .returning();
      return created;
    });
    if (claimed.status === "completed") {
      res.json(claimed.payload.result);
      return;
    }
    const lease = and(
      eq(queue.id, claimed.id),
      eq(queue.attempts, claimed.attempts),
      eq(queue.status, "processing"),
    );
    try {
      const known = providerId.safeParse(claimed.payload.postedId);
      if (known.success && adjustmentId && known.data !== adjustmentId)
        throw new Error(
          "The original QuickBooks response identified a different adjustment. Verify that saved adjustment first.",
        );
      const result = await exportStockReturnAdjustment(
        approval,
        providerFor(company),
        {
          allowCreate: claimed.payload.submitted !== true,
          knownAdjustmentId: known.success ? known.data : adjustmentId,
          verifyCurrent: async () => {
            const current = await prepare(company, choice);
            if (current.approved.fingerprint !== fingerprint)
              throw new Error(
                "The verified stock or accounting evidence changed. Preview the return again.",
              );
          },
          markSubmitting: async () =>
            db.transaction(async (tx) => {
              await lockStockProduct(tx, choice.productId);
              const [latest] = await localBalances(
                company,
                tx,
                choice.productId,
              );
              if (
                !latest ||
                !sameQuantity(latest.localOnHand, approval.target) ||
                latest.itemId !==
                  approval.document.Line[0].ItemAdjustmentLineDetail.ItemRef
                    .value
              )
                throw new Error(
                  "Catalyst stock or its item mapping changed after review. Preview again.",
                );
              if ((await sharedItemMappings(company, tx, latest.itemId)).length)
                throw new Error(
                  "The mapped QuickBooks item is shared by another Catalyst SKU. Reconcile its mappings before adjusting stock.",
                );
              const [marked] = await tx
                .update(queue)
                .set({ payload: { ...approval, submitted: true } })
                .where(lease)
                .returning({ id: queue.id });
              if (!marked)
                throw new Error(
                  "This approval is no longer processing. Refresh its status.",
                );
            }),
          recordAdjustmentId: async (postedId) => {
            const [saved] = await db
              .update(queue)
              .set({ payload: { ...approval, submitted: true, postedId } })
              .where(lease)
              .returning({ id: queue.id });
            if (!saved)
              throw new Error(
                "Another attempt is reconciling this reference. Refresh its status.",
              );
          },
        },
      );
      const finished = new Date().toISOString();
      const [completed] = await db
        .update(queue)
        .set({
          status: "completed",
          payload: {
            ...approval,
            submitted: true,
            postedId: result.adjustmentId,
            result,
          },
          completedAt: finished,
          updatedAt: finished,
        })
        .where(lease)
        .returning({ id: queue.id });
      if (!completed)
        throw new Error(
          "Another attempt is reconciling this reference. Refresh its status.",
        );
      await audit("quickbooks.stock_return_adjusted", {
        userId: req.auth!.userId,
        entityType: "inventory_movement",
        entityId: choice.returnId,
        details: {
          realmId: company.realmId,
          adjustmentId: result.adjustmentId,
          fingerprint,
        },
      });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "QuickBooks inventory reconciliation failed.";
      await db
        .update(queue)
        .set({
          status: "failed",
          lastError: message,
          updatedAt: new Date().toISOString(),
        })
        .where(lease);
      throw new DomainError(409, message);
    }
  }),
);

export default router;
