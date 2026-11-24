import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  auditEventsTable,
  inventoryAccountingCasesTable as cases,
  inventoryAccountingCaseReturnsTable as claims,
  inventoryAccountingCaseEventsTable as events,
  inventoryMovementsTable as movements,
  inventoryTransfersTable as transfers,
  productsTable,
  jobsTable,
  invoicesTable,
  purchaseReceiptLinesTable as receiptLines,
  vendorBillReceiptAllocationsTable as allocations,
  vendorBillCoverageBindingsTable as bindings,
  quickbooksEntityMappingsTable as mappings,
  quickbooksConnectionsTable as connections,
  quickbooksSyncJobsTable as queue,
} from "@workspace/db";
import {
  coverageDecimal,
  coverageMicros,
  planStockReturns,
  type InventoryAccountingCase,
  type InventoryAccountingChoice,
  type InventoryAccountingPreview,
  type StockReturnPlan,
  type StockReturnPlanInput,
  type ReturnPlanProviderProof,
  type ReturnPlanPriorClaim,
} from "@workspace/domain";
import {
  assertCoverageOwner,
  type CoverageTransaction,
} from "./bill-coverage-owner";
import { loadCoverageEvidence } from "./bill-receipt-coverage";
import { cutoverHash } from "./cutover-hash";
import { lockStockProduct } from "./inventory-stock";
import { DomainError } from "./operations-rules";
import { getConnection, qboQuery, qboRequest } from "./quickbooks";
import {
  approvedStockAdjustment,
  inventoryItem,
  matchesAdjustment,
  quantityUnits,
  stockAdjustmentEntity,
} from "./quickbooks-inventory-reconciliation";

type Reader = typeof db | CoverageTransaction;
type Json = Record<string, unknown>;
type CaseRow = typeof cases.$inferSelect;
const localId = z.string().min(1).max(200);
const providerId = z.string().regex(/^\d{1,30}$/);
export const accountingChoiceSchema = z
  .object({
    productId: localId,
    jobId: localId,
    returnIds: z.array(localId).min(1).max(100),
    note: z.string().trim().min(10).max(1000),
  })
  .strict();
export const accountingNoteSchema = z.string().trim().min(10).max(1000);
const fail = (message: string): never => {
  throw new DomainError(409, message);
};
const exact = (value: number) => {
  const units = quantityUnits(value);
  if (units === null || units < 0)
    fail(
      "A stock or invoice quantity cannot be represented exactly to six decimal places.",
    );
  return coverageDecimal(BigInt(units!));
};
const exactSum = (values: number[]) => {
  const result = coverageDecimal(
    values.reduce((sum, value) => sum + coverageMicros(exact(value)), 0n),
  );
  coverageMicros(result);
  return result;
};
const exactObservedQuantity = (value: number) => {
  const units = quantityUnits(value);
  if (units === null)
    fail(
      "The current provider quantity cannot be represented exactly to six decimal places.",
    );
  coverageMicros(coverageDecimal(BigInt(Math.abs(units!))));
  return coverageDecimal(BigInt(units!));
};
const frozen = (value: unknown) => ({
  expectedFingerprint: cutoverHash(value),
  currentFingerprint: cutoverHash(value),
});
const referenceFor = (id: string) =>
  "CWRC" + id.replaceAll("-", "").slice(0, 16);
// Retain the full original snapshots, but compare the original accepted stock
// identity/cost rather than later PO status updates, bill payments or name edits.
export function receiptAccountingInvariant(value: unknown) {
  const row = value as any;
  return {
    line: row?.line,
    header: row?.header,
    order: row?.order && {
      id: row.order.id,
      warehouseId: row.order.warehouseId,
      supplier: row.order.supplier,
    },
    orderLine: row?.orderLine,
    movement: row?.movement,
    product: row?.product,
    warehouse: row?.warehouse && { id: row.warehouse.id },
  };
}
export function providerCoverageInvariant(value: unknown) {
  const row = value as any,
    bill = row?.bill;
  return {
    bill: bill && {
      Id: bill.Id,
      DocNumber: bill.DocNumber,
      TxnDate: bill.TxnDate,
      VendorRef: bill.VendorRef,
      Line: bill.Line,
      CurrencyRef: bill.CurrencyRef,
      PrivateNote: bill.PrivateNote,
    },
    vendor: row?.vendor && { Id: row.vendor.Id, Active: row.vendor.Active },
    items: Array.isArray(row?.items)
      ? row.items
          .map((item: any) => ({
            Id: item.Id,
            Active: item.Active,
            Type: item.Type,
            TrackQtyOnHand: item.TrackQtyOnHand,
            IncomeAccountRef: item.IncomeAccountRef,
            ExpenseAccountRef: item.ExpenseAccountRef,
            AssetAccountRef: item.AssetAccountRef,
          }))
          .sort((a: any, b: any) => a.Id.localeCompare(b.Id))
      : row?.items,
  };
}
export function caseOperationalInvariant(product: any, job: any, rows: any[]) {
  return {
    product: product && {
      id: product.id,
      unit: product.unit,
      inventoryType: product.inventoryType,
    },
    job: job && { id: job.id, customerId: job.customerId },
    movements: rows.map((row) => ({
      id: row.id,
      productId: row.productId,
      jobId: row.jobId,
      warehouseId: row.warehouseId,
      binId: row.binId,
      returnOfMovementId: row.returnOfMovementId,
      quantity: row.quantity,
      kind: row.kind,
      issueUnitCost: row.issueUnitCost,
      acquisitionUnitCost: row.acquisitionUnitCost,
      costAllocations: row.costAllocations,
      createdAt: row.createdAt,
    })),
  };
}
const manual = (
  message: string,
  code: Parameters<typeof manualPlan>[1] = "invalid_evidence",
) => manualPlan(message, code);
function manualPlan(
  message: string,
  code:
    | "invalid_evidence"
    | "incomplete_scope"
    | "wrong_company_or_item"
    | "receipt_bill_coverage_unverified"
    | "prior_claim_unresolved",
): StockReturnPlan {
  return {
    kind: "manual_review",
    reasonCodes: [code],
    explanations: [message],
    providerSubmissionAllowed: false,
    financialActionsAllowed: false,
    revaluesInventory: false,
  };
}
function present(
  row: CaseRow,
  rows: Array<typeof events.$inferSelect>,
): InventoryAccountingCase {
  const source = row.sourceSnapshot as {
    plan: StockReturnPlan;
    company: InventoryAccountingPreview["company"];
  };
  return {
    id: row.id,
    kind: row.kind,
    productId: row.productId,
    jobId: row.jobId,
    note: row.note,
    reasonCodes: row.reasonCodes,
    reference: referenceFor(row.id),
    plan: source.plan,
    company: source.company,
    events: rows
      .filter((event) => event.caseId === row.id)
      .map((event) => ({
        id: event.id,
        kind: event.kind,
        note: event.note,
        adjustmentId: event.adjustmentId,
        ...((
          event.providerSnapshot as {
            balanceObservation?: InventoryAccountingCase["events"][number]["balanceObservation"];
          } | null
        )?.balanceObservation
          ? {
              balanceObservation: (event.providerSnapshot as any)
                .balanceObservation,
            }
          : {}),
        createdAt: event.createdAt,
      })),
    createdAt: row.createdAt,
  };
}
export async function listAccountingCases(reader: Reader, productId: string) {
  const rows = await reader
    .select()
    .from(cases)
    .where(eq(cases.productId, productId))
    .orderBy(desc(cases.createdAt), asc(cases.id))
    .limit(101);
  const notes = rows.length
    ? await reader
        .select()
        .from(events)
        .where(
          inArray(
            events.caseId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(asc(events.createdAt), asc(events.id))
    : [];
  return {
    cases: rows.slice(0, 100).map((row) => present(row, notes)),
    hasMore: rows.length > 100,
  };
}
export async function accountingCaseOptions(productId: string) {
  const [product] = await db
    .select({
      id: productsTable.id,
      sku: productsTable.sku,
      name: productsTable.name,
      unit: productsTable.unit,
    })
    .from(productsTable)
    .where(eq(productsTable.id, productId));
  if (!product)
    throw new DomainError(404, "Stock product not found in this company.");
  const returned = await db
    .select({ movement: movements, job: jobsTable })
    .from(movements)
    .innerJoin(jobsTable, eq(jobsTable.id, movements.jobId))
    .where(
      and(
        eq(movements.productId, productId),
        eq(movements.kind, "return"),
        sql`${movements.returnOfMovementId} IS NOT NULL`,
      ),
    )
    .orderBy(desc(movements.createdAt), asc(movements.id))
    .limit(501);
  const history = await listAccountingCases(db, productId);
  return {
    product,
    jobs: [
      ...new Map(
        returned.map((row) => [
          row.job.id,
          {
            id: row.job.id,
            number: row.job.jobNumber,
            customerName: row.job.customerName,
          },
        ]),
      ).values(),
    ],
    returns: returned.slice(0, 500).map(({ movement }) => ({
      id: movement.id,
      jobId: movement.jobId!,
      issueId: movement.returnOfMovementId!,
      quantity: exact(movement.quantity),
      reason: movement.reason,
      createdAt: movement.createdAt,
    })),
    cases: history.cases,
    hasMore: history.hasMore || returned.length > 500,
  };
}

async function refundsForCustomer(customerId: string, connectionId: string) {
  // A complete bounded current lookup prevents an unlinked refund/credit from
  // being mistaken for an unexplained return. Any such document stays manual.
  const rows: Array<{
    id: string;
    type: string;
    itemLines: Array<{ itemId: string; quantity: string }>;
  }> = [];
  for (const type of ["CreditMemo", "RefundReceipt"] as const) {
    for (let start = 1; start <= 5001; start += 1000) {
      const response = await qboQuery(
        `select * from ${type} where CustomerRef = '${customerId}' startposition ${start} maxresults 1000`,
        connectionId,
      );
      const page =
        response.QueryResponse?.[type] ?? (response.QueryResponse ? [] : null);
      if (!Array.isArray(page) || page.length > 1000)
        fail(
          "Complete current customer credit/refund evidence is unavailable.",
        );
      for (const row of page) {
        if (!providerId.safeParse(row.Id).success || !Array.isArray(row.Line))
          fail("A current credit/refund document has incomplete source lines.");
        rows.push({
          id: row.Id,
          type,
          itemLines: row.Line.flatMap((line: any) =>
            line.DetailType === "SalesItemLineDetail" &&
            providerId.safeParse(line.SalesItemLineDetail?.ItemRef?.value)
              .success &&
            typeof line.SalesItemLineDetail.Qty === "number"
              ? [
                  {
                    itemId: line.SalesItemLineDetail.ItemRef.value,
                    quantity: exact(line.SalesItemLineDetail.Qty),
                  },
                ]
              : [],
          ),
        });
      }
      if (page.length < 1000) break;
      if (start === 5001)
        fail(
          "The current customer credit/refund evidence exceeds this bounded review; use manual accounting review.",
        );
    }
  }
  return rows;
}

async function loadPlan(reader: Reader, choice: InventoryAccountingChoice) {
  if (new Set(choice.returnIds).size !== choice.returnIds.length)
    fail("Select each original return once.");
  const [product] = await reader
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, choice.productId));
  const [job] = await reader
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, choice.jobId));
  if (!product || !job)
    throw new DomainError(
      404,
      "The selected stock product or job was not found in this company.",
    );
  const movementRows = await reader
    .select()
    .from(movements)
    .where(
      and(
        eq(movements.productId, product.id),
        eq(movements.jobId, job.id),
        inArray(movements.kind, ["consume", "return"]),
      ),
    )
    .orderBy(asc(movements.id))
    .limit(1001);
  if (
    choice.returnIds.some(
      (id) =>
        !movementRows.some(
          (row) =>
            row.id === id &&
            row.kind === "return" &&
            row.returnOfMovementId &&
            row.quantity > 0,
        ),
    )
  )
    fail(
      "Select actual positive returned stock tied to this job's original issue.",
    );
  const baseSource = { product, job, movements: movementRows };
  const companyRow = await getConnection();
  const company =
    companyRow?.status === "connected" &&
    ["sandbox", "production"].includes(companyRow.environment)
      ? {
          connectionId: companyRow.id,
          realmId: companyRow.realmId,
          environment: companyRow.environment as "sandbox" | "production",
          companyName: companyRow.companyName,
        }
      : null;
  const finish = (plan: StockReturnPlan, evidence: Json = {}) => {
    const source = { ...baseSource, ...evidence, company, plan };
    return {
      preview: {
        choice,
        company,
        plan,
        fingerprint: cutoverHash({ choice, source }),
        observedAt: new Date().toISOString(),
      } satisfies InventoryAccountingPreview,
      source,
    };
  };
  if (!company)
    return finish(
      manual(
        "No exact QuickBooks company is connected. The original job return is retained for an owner/accountant review; connecting later never marks it accounted for.",
        "wrong_company_or_item",
      ),
    );
  if (movementRows.length > 1000)
    return finish(
      manual(
        "This job/product exceeds the complete bounded movement review. No partial quantity plan was inferred.",
        "incomplete_scope",
      ),
    );
  const links = await reader
    .select()
    .from(mappings)
    .where(
      and(
        eq(mappings.realmId, company.realmId),
        eq(mappings.environment, company.environment),
        eq(mappings.status, "linked"),
      ),
    );
  const itemLink = links.filter(
    (row) => row.entityType === "item" && row.localId === product.id,
  );
  const customerLink = links.filter(
    (row) => row.entityType === "customer" && row.localId === job.id,
  );
  if (
    itemLink.length !== 1 ||
    customerLink.length !== 1 ||
    !providerId.safeParse(itemLink[0].quickbooksId).success ||
    !providerId.safeParse(customerLink[0].quickbooksId).success ||
    links.some(
      (row) =>
        row.entityType === "item" &&
        row.localId !== product.id &&
        row.quickbooksId === itemLink[0].quickbooksId,
    )
  )
    return finish(
      manual(
        "Map one unique tracked inventory item and the exact job customer in this company before constructing a provider quantity plan.",
        "wrong_company_or_item",
      ),
      { links },
    );
  const itemId = itemLink[0].quickbooksId,
    customerId = customerLink[0].quickbooksId;
  const movementsById = new Map(movementRows.map((row) => [row.id, row]));
  const receiptMovementIds = [
    ...new Set(
      movementRows.flatMap((row) =>
        (row.costAllocations ?? [])
          .filter((slice) => slice.source === "purchase_order")
          .map((slice) => slice.sourceMovementId),
      ),
    ),
  ];
  const receiptRefs = receiptMovementIds.length
    ? await reader
        .select()
        .from(receiptLines)
        .where(inArray(receiptLines.movementId, receiptMovementIds))
    : [];
  if (
    !receiptRefs.length ||
    new Set(receiptRefs.map((row) => row.movementId)).size !==
      receiptMovementIds.length
  )
    return finish(
      manual(
        "Every issue and return must retain exact accepted purchase receipt sources. Opening/manual stock and missing purchase receipt evidence require accounting review.",
        "receipt_bill_coverage_unverified",
      ),
      { links, receiptRefs },
    );
  const baseAllocations = await reader
    .select()
    .from(allocations)
    .where(
      inArray(
        allocations.receiptLineId,
        receiptRefs.map((row) => row.id),
      ),
    );
  const allBindings = baseAllocations.length
    ? await reader
        .select()
        .from(bindings)
        .where(
          inArray(
            bindings.allocationId,
            baseAllocations.map((row) => row.id),
          ),
        )
    : [];
  const companyBindings = allBindings.filter(
    (row) =>
      row.realmId === company.realmId &&
      row.environment === company.environment,
  );
  const priorCases = await reader
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.productId, product.id),
        eq(cases.jobId, job.id),
        eq(cases.realmId, company.realmId),
        eq(cases.environment, company.environment),
      ),
    )
    .orderBy(asc(cases.id));
  const priorEvents = priorCases.length
    ? await reader
        .select()
        .from(events)
        .where(
          inArray(
            events.caseId,
            priorCases.map((row) => row.id),
          ),
        )
    : [];
  const priorLegacy = await reader
    .select()
    .from(queue)
    .where(
      and(
        eq(queue.entityType, stockAdjustmentEntity),
        sql`${queue.payload}->'choice'->>'productId'=${product.id}`,
      ),
    )
    .orderBy(asc(queue.id));
  const localInvoices = await reader
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.jobId, job.id))
    .orderBy(asc(invoicesTable.id))
    .limit(101);
  const transitRows = await reader
    .select()
    .from(transfers)
    .where(
      and(
        eq(transfers.productId, product.id),
        eq(transfers.status, "In transit"),
      ),
    );
  const evidence = {
    links,
    receiptRefs,
    baseAllocations,
    allBindings,
    priorCases,
    priorEvents,
    priorLegacy,
    invoices: localInvoices,
    transit: transitRows,
  };
  if (!companyBindings.length)
    return finish(
      manual(
        "Link the accepted receipts to exact supplier bill merchandise lines, then explicitly append verified company evidence. Local-only matching never establishes a provider bill.",
        "receipt_bill_coverage_unverified",
      ),
      evidence,
    );
  if (localInvoices.length > 100)
    return finish(
      manual(
        "This job exceeds the complete bounded customer invoice review.",
        "incomplete_scope",
      ),
      evidence,
    );
  try {
    const loaded = await loadCoverageEvidence(
      reader,
      [...new Set(companyBindings.map((row) => row.billId))],
      receiptRefs.map((row) => row.id),
    );
    const item = inventoryItem.parse(
      (await qboRequest(`/item/${itemId}`, {}, company.connectionId)).Item,
    );
    if (
      item.Id !== itemId ||
      !product.active ||
      product.inventoryType !== "Inventory"
    )
      fail(
        "The uniquely mapped stock item is not active inventory in this company.",
      );
    const companyInfo = (
      await qboRequest(
        `/companyinfo/${company.realmId}`,
        {},
        company.connectionId,
      )
    ).CompanyInfo;
    // CompanyInfo.Id is the object ID (often "1"), not the OAuth realm ID.
    // qboRequest binds the endpoint and credentials to this exact connection.
    if (
      !providerId.safeParse(companyInfo?.Id).success ||
      !["US", "USA", "United States"].includes(companyInfo.Country)
    )
      fail(
        "The current provider did not return a supported US accounting company.",
      );
    const preferences = (
      await qboRequest("/preferences", {}, company.connectionId)
    ).Preferences;
    const currency = preferences?.CurrencyPrefs?.HomeCurrency?.value;
    if (currency !== "USD")
      fail(
        "This quantity plan requires explicit verified USD company currency; currency conversion is manual.",
      );
    const providerProof = (
      documentId: string,
      expected: unknown,
      current = expected,
    ): ReturnPlanProviderProof => ({
      verified: true,
      ...company,
      itemId,
      documentId,
      expectedFingerprint: cutoverHash(expected),
      currentFingerprint: cutoverHash(current),
    });
    const refunds = await refundsForCustomer(customerId, company.connectionId);
    const normalizedInvoices: StockReturnPlanInput["invoices"] = [],
      providerInvoices: Json[] = [];
    for (const invoice of localInvoices.filter((row) =>
      row.lineItems.some((line) => line.productId === product.id),
    )) {
      const invoiceLink = links.filter(
        (row) => row.entityType === "invoice" && row.localId === invoice.id,
      );
      if (
        invoiceLink.length !== 1 ||
        !providerId.safeParse(invoiceLink[0].quickbooksId).success ||
        ["Draft", "Credited", "Refunded", "Voided"].includes(invoice.status) ||
        invoice.refundedAmount !== 0
      )
        fail(
          "Every same-job stock invoice must be posted, mapped, active and free of an unresolved local credit/refund.",
        );
      const remote = (
        await qboRequest(
          `/invoice/${invoiceLink[0].quickbooksId}`,
          {},
          company.connectionId,
        )
      ).Invoice;
      if (
        !remote ||
        remote.Id !== invoiceLink[0].quickbooksId ||
        remote.DocNumber !== invoice.invoiceNumber ||
        remote.CustomerRef?.value !== customerId ||
        (remote.CurrencyRef?.value && remote.CurrencyRef.value !== currency) ||
        /^voided\b/i.test(remote.PrivateNote ?? "") ||
        !Array.isArray(remote.Line)
      )
        fail(
          "The current provider invoice no longer matches the original same-job customer invoice.",
        );
      providerInvoices.push(remote);
      const selected = invoice.lineItems
        .filter((line) => line.productId === product.id)
        .sort((a, b) => a.id.localeCompare(b.id));
      const remoteLines = remote.Line.filter(
        (line: any) =>
          line.DetailType === "SalesItemLineDetail" &&
          line.SalesItemLineDetail?.ItemRef?.value === itemId,
      )
        .map((line: any) => line.SalesItemLineDetail)
        .sort(
          (a: any, b: any) =>
            exact(a.Qty).localeCompare(exact(b.Qty)) ||
            exact(a.UnitPrice).localeCompare(exact(b.UnitPrice)),
        );
      const localLines = [...selected].sort(
        (a, b) =>
          exact(a.quantity).localeCompare(exact(b.quantity)) ||
          exact(a.unitPrice).localeCompare(exact(b.unitPrice)),
      );
      if (localLines.length !== remoteLines.length)
        fail(
          "Current customer invoice merchandise lines differ from the original job evidence.",
        );
      const linked = [...refunds];
      for (const txn of remote.LinkedTxn ?? []) {
        if (
          !providerId.safeParse(txn.TxnId).success ||
          typeof txn.TxnType !== "string"
        )
          fail("A linked invoice transaction is incomplete.");
        if (
          ["CreditMemo", "RefundReceipt"].includes(txn.TxnType) &&
          !linked.some(
            (row) => row.id === txn.TxnId && row.type === txn.TxnType,
          )
        )
          fail(
            "A linked invoice credit/refund was not returned in the complete current customer lookup.",
          );
      }
      normalizedInvoices.push({
        id: invoice.id,
        jobId: job.id,
        customerId: job.customerId ?? job.id,
        providerCustomerId: customerId,
        providerInvoiceId: remote.Id,
        currency,
        active: true,
        voided: false,
        linkedTransactionsComplete: true,
        linkedDocuments: linked,
        lines: localLines.map((line, index) => ({
          id: line.id,
          productId: product.id,
          stockUnit: product.unit,
          itemId,
          detailType: "Inventory",
          localQuantity: exact(line.quantity),
          remoteQuantity: exact(remoteLines[index].Qty),
          localUnitPrice: exact(line.unitPrice),
          remoteUnitPrice: exact(remoteLines[index].UnitPrice),
        })),
        proof: providerProof(remote.Id, remote),
      });
    }
    const priorClaims: ReturnPlanPriorClaim[] = [];
    for (const row of priorLegacy) {
      const approval = approvedStockAdjustment.safeParse(row.payload);
      if (
        !approval.success ||
        !movementsById.has(approval.data.choice.returnId)
      )
        continue;
      if (approval.data.choice.connectionId !== company.connectionId)
        fail(
          "An earlier return claim belongs to another or no-longer-retained accounting grant. Review that exact historical company outcome; reconnecting cannot silently free an unknown claim.",
        );
      const approved = approval.data,
        originalReturn = movementsById.get(approved.choice.returnId)!;
      let adjustment: ReturnPlanPriorClaim["adjustment"] = null;
      if (
        row.status === "completed" &&
        providerId.safeParse(row.payload.postedId).success
      ) {
        const remote = (
          await qboRequest(
            `/inventoryadjustment/${row.payload.postedId}`,
            {},
            company.connectionId,
          )
        ).InventoryAdjustment;
        if (
          matchesAdjustment(approved.document, remote) !== row.payload.postedId
        )
          fail(
            "A prior automatic return's actual adjustment no longer matches its exact approved source reference.",
          );
        adjustment = {
          id: String(row.payload.postedId),
          quantity: exact(
            approved.document.Line[0].ItemAdjustmentLineDetail.QtyDiff,
          ),
          sourceReferenceVerified: true,
          verifiedClaimId: row.id,
          verifiedReturnIds: [originalReturn.id],
          proof: providerProof(String(row.payload.postedId), remote),
        };
      }
      priorClaims.push({
        id: row.id,
        origin: "legacy_auto",
        state: adjustment ? "confirmed" : "unknown",
        jobId: job.id,
        productId: product.id,
        realmId: company.realmId,
        environment: company.environment,
        returns: [
          {
            returnId: originalReturn.id,
            quantity: exact(originalReturn.quantity),
          },
        ],
        neverSubmitted: false,
        adjustment,
        snapshot: frozen(row),
      });
    }
    for (const row of priorCases.filter(
      (row) => row.kind === "return_quantity_plan",
    )) {
      const source = row.sourceSnapshot as {
        plan: Extract<StockReturnPlan, { kind: "ready_quantity_plan" }>;
        input: StockReturnPlanInput;
      };
      const verified = priorEvents.find(
        (event) =>
          event.caseId === row.id &&
          event.kind === "external_adjustment_verified",
      );
      let adjustment: ReturnPlanPriorClaim["adjustment"] = null;
      if (verified?.adjustmentId) {
        const remote = (
          await qboRequest(
            `/inventoryadjustment/${verified.adjustmentId}`,
            {},
            company.connectionId,
          )
        ).InventoryAdjustment;
        validateExternalAdjustment(row, remote);
        if (
          cutoverHash(remote) !==
          cutoverHash(
            (verified.providerSnapshot as { adjustment: unknown }).adjustment,
          )
        )
          fail(
            "A previously verified external adjustment changed; reconcile it before another return plan.",
          );
        adjustment = {
          id: verified.adjustmentId,
          quantity: source.plan.quantityDifference,
          sourceReferenceVerified: true,
          verifiedClaimId: row.id,
          verifiedReturnIds: source.plan.returnIds,
          proof: providerProof(verified.adjustmentId, remote),
        };
      }
      priorClaims.push({
        id: row.id,
        origin: "manual_case",
        state: adjustment ? "confirmed" : "pending",
        jobId: job.id,
        productId: product.id,
        realmId: company.realmId,
        environment: company.environment,
        returns: source.plan.returnQuantities,
        neverSubmitted: false,
        adjustment,
        snapshot: frozen({ row, verified }),
      });
    }
    const byMovement = new Map(
      receiptRefs.map((row) => [row.movementId, row.id]),
    );
    const normalizeMovement = (row: typeof movements.$inferSelect) => {
      const grouped = new Map<
        string,
        StockReturnPlanInput["issues"][number]["slices"][number]
      >();
      for (const slice of row.costAllocations ?? []) {
        if (slice.source !== "purchase_order")
          fail(
            "Opening, historical and manual stock sources require separate accounting review.",
          );
        const receiptLineId =
          byMovement.get(slice.sourceMovementId) ?? slice.sourceMovementId;
        const prior = grouped.get(receiptLineId);
        if (
          prior &&
          (prior.movementId !== slice.sourceMovementId ||
            coverageMicros(prior.acquisitionUnitCost) !==
              coverageMicros(slice.unitCost))
        )
          fail(
            "Raw stock source slices disagree on one original receipt's movement or acquisition cost.",
          );
        grouped.set(receiptLineId, {
          source: "purchase_order",
          receiptLineId,
          movementId: slice.sourceMovementId,
          quantity: coverageDecimal(
            (prior ? coverageMicros(prior.quantity) : 0n) +
              coverageMicros(exact(slice.quantity)),
          ),
          acquisitionUnitCost: slice.unitCost,
        });
      }
      if (
        (row.kind === "consume" && row.quantity >= 0) ||
        (row.kind === "return" && row.quantity <= 0)
      )
        fail(
          "Original job stock movements have an inconsistent quantity direction.",
        );
      return {
        id: row.id,
        jobId: job.id,
        productId: product.id,
        stockUnit: product.unit,
        quantity: exact(Math.abs(row.quantity)),
        kind: row.kind as "consume" | "return",
        slices: [...grouped.values()].sort((a, b) =>
          a.receiptLineId.localeCompare(b.receiptLineId),
        ),
        snapshot: frozen(row),
      };
    };
    const input: StockReturnPlanInput = {
      company: { ...company, currency },
      customerId: job.customerId ?? job.id,
      providerCustomerId: customerId,
      jobId: job.id,
      productId: product.id,
      itemId,
      stockUnit: product.unit,
      scope: {
        ...frozen(evidence),
        allIssueSourcesIncluded: true,
        allJobReturnsIncluded: true,
        allPriorClaimsIncluded: true,
        invoiceRefundLookupsComplete: true,
      },
      quantity: {
        worksTotalIncludingTransit: exactSum([
          product.quantityOnHand,
          ...transitRows.map((row) => row.quantity),
        ]),
        quickBooksOnHand: exact(item.QtyOnHand),
        itemActive: true,
        itemType: "Inventory",
        trackQtyOnHand: true,
        proof: providerProof(itemId, item),
      },
      receipts: loaded.receipts.map((receipt) => {
        const original = baseAllocations.find(
          (row) => row.receiptLineId === receipt.id,
        );
        return {
          id: receipt.id,
          receiptId: receipt.receiptId,
          orderId: receipt.orderId,
          movementId: receiptRefs.find((row) => row.id === receipt.id)!
            .movementId!,
          productId: product.id,
          stockUnit: receipt.stockUnit,
          source: "purchase_order",
          supplierKey: receipt.supplier.trim().toLowerCase(),
          acceptedQuantity: receipt.quantity,
          allocatedQuantity: receipt.allocatedQuantity,
          providerBoundQuantity: coverageDecimal(
            companyBindings
              .filter(
                (binding) =>
                  baseAllocations.find(
                    (base) => base.id === binding.allocationId,
                  )?.receiptLineId === receipt.id,
              )
              .reduce((sum, row) => sum + coverageMicros(row.quantity), 0n),
          ),
          acquisitionUnitCost: receipt.unitCost,
          snapshot: {
            expectedFingerprint: cutoverHash(
              receiptAccountingInvariant(original?.receiptSnapshot),
            ),
            currentFingerprint: cutoverHash(
              receiptAccountingInvariant(loaded.receiptRows.get(receipt.id)),
            ),
          },
        };
      }),
      billLines: loaded.billLines
        .filter(
          (line) =>
            line.productId === product.id &&
            companyBindings.some(
              (binding) =>
                binding.billId === line.billId &&
                binding.billLineIndex === line.billLineIndex,
            ),
        )
        .map((line) => {
          const bill = loaded.billEvidence.get(line.billId)!,
            binding = companyBindings.find(
              (row) =>
                row.billId === line.billId &&
                row.billLineIndex === line.billLineIndex,
            )!;
          return {
            key: line.key,
            billQueueId: line.billId,
            billLineIndex: line.billLineIndex,
            providerBillId: line.postedBillId!,
            vendorId: line.vendorId!,
            supplierKey: line.supplier.trim().toLowerCase(),
            itemId: line.itemId!,
            productId: product.id,
            stockUnit: line.stockUnit,
            currency,
            quantity: line.quantity,
            boundQuantity: line.allocatedQuantity,
            billedUnitCost: line.unitCost,
            active: true,
            proof: providerProof(
              line.postedBillId!,
              {
                source: binding.billSource,
                provider: providerCoverageInvariant(binding.providerSnapshot),
              },
              {
                source: bill.billSource,
                provider: providerCoverageInvariant(bill.provider),
              },
            ),
          };
        }),
      bindings: companyBindings.map((binding) => {
        const base = baseAllocations.find(
            (row) => row.id === binding.allocationId,
          )!,
          identity = binding.identitySnapshot as any;
        return {
          id: binding.id,
          receiptLineId: base.receiptLineId,
          billLineKey: `${binding.billId}:${binding.billLineIndex}`,
          quantity: binding.quantity,
          base: {
            id: base.id,
            receiptLineId: base.receiptLineId,
            productId: base.productId,
            stockUnit: base.stockUnit,
            quantity: base.quantity,
            providerBoundQuantity: coverageDecimal(
              allBindings
                .filter((row) => row.allocationId === base.id)
                .reduce((sum, row) => sum + coverageMicros(row.quantity), 0n),
            ),
            receiptUnitCost: base.receiptUnitCost,
            snapshot: frozen(base),
          },
          receiptSourceFingerprint: cutoverHash(
            receiptAccountingInvariant(base.receiptSnapshot),
          ),
          billSourceFingerprint: cutoverHash({
            source: binding.billSource,
            provider: providerCoverageInvariant(binding.providerSnapshot),
          }),
          varianceNote: binding.varianceNote,
          varianceClassification: identity.varianceClassification,
          roundingEvidence: identity.roundingEvidence ?? null,
          snapshot: frozen(binding),
        };
      }),
      issues: movementRows
        .filter((row) => row.kind === "consume")
        .map(normalizeMovement),
      returns: movementRows
        .filter((row) => row.kind === "return")
        .map((row) => ({
          ...normalizeMovement(row),
          issueId: row.returnOfMovementId ?? "",
        })),
      selectedReturnIds: choice.returnIds,
      invoices: normalizedInvoices,
      priorClaims,
    };
    return finish(planStockReturns(input), {
      ...evidence,
      input,
      providerEvidence: {
        item,
        companyInfo,
        preferences,
        invoices: providerInvoices,
        refunds,
        bills: [...loaded.billEvidence.values()].map((row) => ({
          source: row.billSource,
          provider: row.provider,
        })),
      },
    });
  } catch (error) {
    return finish(
      manual(
        error instanceof DomainError
          ? error.message
          : "Current provider/source evidence could not be verified completely. Retain this for an owner/accountant review; no provider outcome or financial adjustment was inferred.",
      ),
      evidence,
    );
  }
}

export async function previewAccountingCase(choice: InventoryAccountingChoice) {
  return (await loadPlan(db, choice)).preview;
}

export async function createAccountingCase(
  choice: InventoryAccountingChoice,
  fingerprint: string,
  requestKey: string,
  actor: string,
) {
  const requestFingerprint = cutoverHash({ choice, fingerprint });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
    await lockStockProduct(tx, choice.productId);
    await assertCoverageOwner(tx, actor);
    const [prior] = await tx
      .select()
      .from(cases)
      .where(eq(cases.requestKey, requestKey));
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint)
        fail(
          "This request key belongs to a different immutable accounting case.",
        );
      return {
        case: present(
          prior,
          await tx.select().from(events).where(eq(events.caseId, prior.id)),
        ),
        replayed: true,
      };
    }
    // Stock writers take the inventory advisory lock before updating job costs.
    // Invoice create/update/delete locks this job before invoice rows, so SHARE
    // here protects both existing invoices and new-invoice insertion phantoms.
    await tx
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(eq(productsTable.id, choice.productId))
      .for("share");
    await tx
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.id, choice.jobId))
      .for("share");
    await tx
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(eq(invoicesTable.jobId, choice.jobId))
      .orderBy(asc(invoicesTable.id))
      .for("share");
    // This per-company lock also covers insertion of a second local SKU mapped
    // to the same provider item; selected-row locks alone miss that phantom.
    await tx.execute(sql`LOCK TABLE quickbooks_entity_mappings IN SHARE MODE`);
    const prepared = await loadPlan(tx, choice);
    if (prepared.preview.fingerprint !== fingerprint)
      fail(
        "Stock, returns, receipts, bill coverage, customer invoices or provider evidence changed. Preview the complete accounting scope again.",
      );
    // Ownership is checked again after provider reads and every potential wait.
    await assertCoverageOwner(tx, actor);
    const at = new Date().toISOString(),
      id = randomUUID(),
      plan = prepared.preview.plan,
      company = prepared.preview.company;
    if (company) {
      const [currentCompany] = await tx
        .select({
          id: connections.id,
          realmId: connections.realmId,
          environment: connections.environment,
          status: connections.status,
        })
        .from(connections)
        .where(eq(connections.id, company.connectionId))
        .for("share");
      if (
        !currentCompany ||
        currentCompany.status !== "connected" ||
        currentCompany.realmId !== company.realmId ||
        currentCompany.environment !== company.environment
      )
        fail(
          "The connected accounting company changed after the current evidence reads. Preview the intended company again.",
        );
    }
    const [row] = await tx
      .insert(cases)
      .values({
        id,
        requestKey,
        requestFingerprint,
        fingerprint,
        kind:
          plan.kind === "ready_quantity_plan"
            ? "return_quantity_plan"
            : "manual_review",
        productId: choice.productId,
        jobId: choice.jobId,
        connectionId: company?.connectionId ?? null,
        realmId: company?.realmId ?? null,
        environment: company?.environment ?? null,
        note: choice.note,
        reasonCodes: plan.kind === "manual_review" ? plan.reasonCodes : [],
        sourceSnapshot: prepared.source,
        document:
          plan.kind === "ready_quantity_plan"
            ? {
                reference: referenceFor(id),
                itemId: (prepared.source as any).input.itemId,
                quantityDifference: plan.quantityDifference,
                returnIds: plan.returnIds,
              }
            : null,
        createdBy: actor,
        createdAt: at,
      })
      .returning();
    if (plan.kind === "ready_quantity_plan")
      for (const returnId of plan.returnIds)
        await tx.insert(claims).values({
          id: randomUUID(),
          caseId: id,
          returnId,
          realmId: company!.realmId,
          environment: company!.environment,
          createdAt: at,
        });
    await tx.insert(auditEventsTable).values({
      id: randomUUID(),
      actorUserId: actor,
      action: "inventory.accounting_case_recorded",
      entityType: "inventory_accounting_case",
      entityId: id,
      details: {
        fingerprint,
        kind: row.kind,
        providerWrite: false,
        stockChanged: false,
      },
      createdAt: at,
    });
    return { case: present(row, []), replayed: false };
  });
}

function validateExternalAdjustment(row: CaseRow, value: unknown) {
  const parsed = z
    .object({
      Id: providerId,
      DocNumber: z.string(),
      TxnDate: z.string().date(),
      Line: z
        .array(
          z.object({
            DetailType: z.literal("ItemAdjustmentLineDetail").optional(),
            ItemAdjustmentLineDetail: z.object({
              ItemRef: z.object({ value: providerId }),
              QtyDiff: z.number(),
            }),
          }),
        )
        .length(1),
    })
    .passthrough()
    .safeParse(value);
  const document = row.document as {
    itemId: string;
    quantityDifference: string;
    reference: string;
  } | null;
  if (
    row.kind !== "return_quantity_plan" ||
    !document ||
    !parsed.success ||
    parsed.data.DocNumber !== document.reference ||
    parsed.data.Line[0].ItemAdjustmentLineDetail.ItemRef.value !==
      document.itemId ||
    exact(parsed.data.Line[0].ItemAdjustmentLineDetail.QtyDiff) !==
      document.quantityDifference
  )
    fail(
      "The actual provider adjustment must contain this case's exact reference, unique inventory item and positive returned quantity. A coincident balance or note is insufficient.",
    );
  const original = row.sourceSnapshot as {
    movements: Array<{ id: string; createdAt: string }>;
    plan: Extract<StockReturnPlan, { kind: "ready_quantity_plan" }>;
    providerEvidence: {
      item: { InvStartDate?: string };
      invoices: Array<{ TxnDate: string }>;
      bills: Array<{ provider: { bill: { TxnDate: string } } }>;
    };
  };
  const officeDay = (value: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value));
  const earliest = [
    ...original.movements
      .filter((movement) => original.plan.returnIds.includes(movement.id))
      .map((movement) => officeDay(movement.createdAt)),
    ...original.providerEvidence.invoices.map((invoice) => invoice.TxnDate),
    ...original.providerEvidence.bills.map(
      (bill) => bill.provider.bill.TxnDate,
    ),
  ]
    .sort()
    .at(-1);
  if (
    !earliest ||
    parsed.data!.TxnDate < earliest ||
    parsed.data!.TxnDate > officeDay(new Date().toISOString()) ||
    (original.providerEvidence.item.InvStartDate &&
      parsed.data!.TxnDate <= original.providerEvidence.item.InvStartDate)
  )
    fail(
      "The actual adjustment date must be after inventory started, on or after the original returns and source transactions, and no later than today.",
    );
  return parsed.data!;
}
export async function appendAccountingCaseEvent(
  caseId: string,
  requestKey: string,
  note: string,
  actor: string,
  adjustmentId?: string,
) {
  const requestFingerprint = cutoverHash({
    caseId,
    note,
    adjustmentId: adjustmentId ?? null,
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
    const [row] = await tx
      .select()
      .from(cases)
      .where(eq(cases.id, caseId))
      .for("update");
    if (!row)
      throw new DomainError(404, "Accounting case not found in this company.");
    await lockStockProduct(tx, row.productId);
    await assertCoverageOwner(tx, actor);
    const [prior] = await tx
      .select()
      .from(events)
      .where(eq(events.requestKey, requestKey));
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint)
        fail(
          "This request key belongs to a different immutable accounting case event.",
        );
      return present(
        row,
        await tx
          .select()
          .from(events)
          .where(eq(events.caseId, row.id))
          .orderBy(asc(events.createdAt), asc(events.id)),
      );
    }
    let providerSnapshot: Json | null = null;
    if (adjustmentId) {
      if (row.kind !== "return_quantity_plan")
        fail(
          "A manual review case does not establish the exact provider quantity plan required for confirming an external adjustment.",
        );
      // Token refresh uses its own connection transaction. Do not hold a SHARE
      // lock on this row across refresh-capable provider requests.
      const [connected] = await tx
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.id, row.connectionId!),
            eq(connections.status, "connected"),
          ),
        );
      if (
        !connected ||
        connected.realmId !== row.realmId ||
        connected.environment !== row.environment
      )
        fail(
          "Reconnect this case's exact original accounting company before verifying its external adjustment.",
        );
      if (
        (
          await tx
            .select({ id: events.id })
            .from(events)
            .where(
              and(
                eq(events.caseId, row.id),
                eq(events.kind, "external_adjustment_verified"),
              ),
            )
        ).length
      )
        fail(
          "This case already retains one verified external adjustment. It cannot be confirmed or counted again.",
        );
      const actual = (
        await qboRequest(
          `/inventoryadjustment/${adjustmentId}`,
          {},
          connected.id,
        )
      ).InventoryAdjustment;
      const adjustment = validateExternalAdjustment(row, actual);
      if (adjustment.Id !== adjustmentId)
        fail("The provider returned a different adjustment identifier.");
      const source = row.sourceSnapshot as { input: StockReturnPlanInput };
      const saved = row.sourceSnapshot as {
        product: unknown;
        job: unknown;
        movements: any[];
        transit: any[];
      };
      const [currentProduct] = await tx
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, row.productId))
        .for("share");
      const [currentJob] = await tx
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, row.jobId!))
        .for("share");
      const originalIds = saved.movements.map((movement) => movement.id);
      const currentMovements = originalIds.length
        ? await tx
            .select()
            .from(movements)
            .where(
              and(
                eq(movements.productId, row.productId),
                eq(movements.jobId, row.jobId!),
                inArray(movements.id, originalIds),
              ),
            )
            .orderBy(asc(movements.id))
        : [];
      const currentTransit = await tx
        .select()
        .from(transfers)
        .where(
          and(
            eq(transfers.productId, row.productId),
            eq(transfers.status, "In transit"),
          ),
        );
      if (
        cutoverHash(
          caseOperationalInvariant(
            currentProduct,
            currentJob,
            currentMovements,
          ),
        ) !==
        cutoverHash(
          caseOperationalInvariant(saved.product, saved.job, saved.movements),
        )
      )
        fail(
          "An original stock identity, job customer or claimed quantity/cost movement changed after this case was recorded. Retain a note and review its original source before confirming an external adjustment.",
        );
      const item = inventoryItem.parse(
        (await qboRequest(`/item/${source.input.itemId}`, {}, connected.id))
          .Item,
      );
      if (item.Id !== source.input.itemId)
        fail("The provider returned a different original inventory item.");
      const worksQuantity = exactSum([
          currentProduct!.quantityOnHand,
          ...currentTransit.map((transfer) => transfer.quantity),
        ]),
        quickBooksQuantity = exactObservedQuantity(item.QtyOnHand);
      providerSnapshot = {
        adjustment: actual,
        item,
        balanceObservation: {
          worksQuantity,
          quickBooksQuantity,
          matchesCurrentWorks: worksQuantity === quickBooksQuantity,
          matchesSavedTarget:
            quickBooksQuantity ===
            source.input.quantity.worksTotalIncludingTransit,
          observedAt: new Date().toISOString(),
        },
      };
      const [currentCompany] = await tx
        .select({
          realmId: connections.realmId,
          environment: connections.environment,
          status: connections.status,
        })
        .from(connections)
        .where(eq(connections.id, connected.id))
        .for("share");
      if (
        !currentCompany ||
        currentCompany.status !== "connected" ||
        currentCompany.realmId !== row.realmId ||
        currentCompany.environment !== row.environment
      )
        fail(
          "The accounting company changed while reading its actual adjustment. Nothing was confirmed.",
        );
    }
    await assertCoverageOwner(tx, actor);
    const at = new Date().toISOString(),
      id = randomUUID();
    await tx.insert(events).values({
      id,
      caseId,
      requestKey,
      requestFingerprint,
      kind: adjustmentId ? "external_adjustment_verified" : "operator_note",
      note,
      adjustmentId: adjustmentId ?? null,
      realmId: adjustmentId ? row.realmId : null,
      environment: adjustmentId ? row.environment : null,
      providerSnapshot,
      createdBy: actor,
      createdAt: at,
    });
    await tx.insert(auditEventsTable).values({
      id: randomUUID(),
      actorUserId: actor,
      action: adjustmentId
        ? "inventory.external_return_adjustment_verified"
        : "inventory.accounting_case_note_added",
      entityType: "inventory_accounting_case",
      entityId: caseId,
      details: { eventId: id, providerWrite: false, stockChanged: false },
      createdAt: at,
    });
    return present(
      row,
      await tx
        .select()
        .from(events)
        .where(eq(events.caseId, row.id))
        .orderBy(asc(events.createdAt), asc(events.id)),
    );
  });
}

export async function assertNoAccountingCaseClaim(
  tx: CoverageTransaction,
  productId: string,
  returnId: string,
  realmId: string,
  environment: string,
) {
  const rows = await tx
    .select({ id: claims.id })
    .from(claims)
    .innerJoin(cases, eq(cases.id, claims.caseId))
    .where(
      and(
        eq(claims.returnId, returnId),
        eq(claims.realmId, realmId),
        eq(claims.environment, environment),
        eq(cases.productId, productId),
      ),
    )
    .limit(1);
  if (rows.length)
    fail(
      "This original return is already reserved by an immutable accounting case. Verify its actual external adjustment instead of submitting the same return again.",
    );
}
