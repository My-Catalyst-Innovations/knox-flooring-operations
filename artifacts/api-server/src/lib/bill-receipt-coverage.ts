import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  auditEventsTable,
  productsTable,
  purchaseOrderLinesTable,
  purchaseOrdersTable,
  purchaseReceiptLinesTable,
  purchaseReceiptsTable,
  inventoryMovementsTable,
  warehousesTable,
  supplierProductAliasesTable,
  supplierBuyPricesTable,
  quickbooksEntityMappingsTable,
  quickbooksConnectionsTable,
  quickbooksSyncJobsTable as bills,
  vendorBillCoverageApprovalsTable as approvals,
  vendorBillReceiptAllocationsTable as allocations,
  vendorBillCoverageBindingsTable as bindings,
} from "@workspace/db";
import { workspaceScopeKey } from "@workspace/db/workspace";
import {
  coverageDecimal,
  coverageMicros,
  previewReceiptBillCoverage,
  convertedSupplierLine,
  type CoverageAllocation,
  type CoverageBillLine,
  type CoverageChoice,
  type CoverageCompany,
  type CoverageMode,
  type CoveragePreview,
  type CoverageReceipt,
} from "@workspace/domain";
import { getConnection, qboRequest } from "./quickbooks";
import {
  matchesPostedBill,
  vendorBillEntity,
  type PreparedBill,
} from "./vendor-bill";
import {
  immutableVendorBillSource,
  vendorBillSourceFingerprint,
} from "./vendor-bill-source";
import { cutoverHash } from "./cutover-hash";
import {
  assertCoverageOwner,
  type CoverageTransaction,
} from "./bill-coverage-owner";
import { DomainError } from "./operations-rules";
import { listVendorBillDocuments } from "./vendor-bill-documents";

type Reader = typeof db | CoverageTransaction;
type Bill = typeof bills.$inferSelect;
type Json = Record<string, unknown>;
const reference = z.string().regex(/^\d{1,30}$/);
const sourceLine = z
  .object({
    supplierSku: z.string(),
    internalSku: z.string(),
    productName: z.string(),
    unit: z.string(),
    expectedUnitCost: z.string(),
    priceEffectiveOn: z.string(),
    priceSource: z.string(),
    quantity: z.string(),
    billedUnitCost: z.string(),
    totalCents: z.number().int().nonnegative().safe(),
    stockConversion: z
      .object({ unit: z.string(), unitsPerBuyUnit: z.string() })
      .optional(),
    stockLine: z
      .object({ quantity: z.string(), unitCost: z.string() })
      .passthrough()
      .optional(),
    sourceCode: z
      .object({
        type: z.enum([
          "supplier_sku",
          "manufacturer_part_number",
          "internal_sku",
        ]),
        value: z.string(),
      })
      .optional(),
    sourceIdentity: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const sourceBill = z
  .object({
    mode: z.enum(["review", "sandbox", "production"]),
    supplier: z.string().min(1),
    lines: z.array(sourceLine).min(1).max(50),
    billNumber: z.string().optional(),
    billDate: z.string().optional(),
    realmId: z.string().optional(),
    quickBooksBill: z.record(z.string(), z.unknown()).optional(),
    postedId: z.string().optional(),
  })
  .passthrough();
const norm = (value: string) => value.trim().toLowerCase();
const decimal = (value: string) => coverageDecimal(coverageMicros(value));
const billNumber = (source: z.infer<typeof sourceBill>) =>
  source.billNumber ?? String(source.quickBooksBill?.DocNumber ?? "");
const billDate = (source: z.infer<typeof sourceBill>) =>
  source.billDate ?? String(source.quickBooksBill?.TxnDate ?? "");
function conflict(message: string): never {
  throw new DomainError(409, message);
}
export const coverageChoiceSchema = z
  .object({
    billIds: z.array(z.string().min(1).max(200)).min(1).max(20),
    allocations: z
      .array(
        z
          .object({
            receiptLineId: z.string().min(1).max(200),
            billId: z.string().min(1).max(200),
            billLineIndex: z.number().int().min(0).max(49),
            quantity: z.string().max(40),
            varianceNote: z.string().trim().max(500),
            existingAllocationId: z.string().min(1).max(200).optional(),
            reconciliationNote: z.string().trim().max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    note: z.string().trim().min(10).max(1000),
  })
  .strict();
type Identity = {
  product: typeof productsTable.$inferSelect;
  alias: typeof supplierProductAliasesTable.$inferSelect;
  price: typeof supplierBuyPricesTable.$inferSelect;
  binding: "original_preparation" | "owner_reconciled_legacy";
};
type BillEvidence = {
  row: Bill;
  source: z.infer<typeof sourceBill>;
  billSource: Json;
  fingerprint: string;
  lines: Map<number, Identity>;
  provider: Json | null;
};
type Remote = { company: CoverageCompany | null; byBill: Record<string, Json> };
type Loaded = {
  mode: CoverageMode;
  company: CoverageCompany | null;
  billRows: Bill[];
  billEvidence: Map<string, BillEvidence>;
  billLines: CoverageBillLine[];
  receipts: CoverageReceipt[];
  receiptRows: Map<string, Json>;
  existing: CoverageAllocation[];
  remote: Remote;
  identityWarnings: string[];
  hasMore: boolean;
};

async function exactIdentity(
  reader: Reader,
  source: z.infer<typeof sourceBill>,
  line: z.infer<typeof sourceLine>,
): Promise<Identity> {
  const code = line.sourceCode?.value ?? line.supplierSku,
    type = line.sourceCode?.type ?? "supplier_sku";
  const original = line.sourceIdentity as
    | {
        version?: unknown;
        binding?: unknown;
        product?: { id?: unknown };
        alias?: { id?: unknown };
        price?: { id?: unknown };
      }
    | undefined;
  const originalIds =
    original?.binding === "original_preparation" &&
    typeof original.product?.id === "string" &&
    typeof original.alias?.id === "string" &&
    typeof original.price?.id === "string"
      ? {
          product: original.product.id,
          alias: original.alias.id,
          price: original.price.id,
        }
      : null;
  if (original && !originalIds)
    conflict(
      "The frozen original bill identity is incomplete; review its original source without guessing identifiers.",
    );
  const codeColumn =
    type === "manufacturer_part_number"
      ? sql`lower(btrim(${supplierProductAliasesTable.manufacturerPartNumber}))`
      : type === "internal_sku"
        ? sql`lower(btrim(${productsTable.sku}))`
        : supplierProductAliasesTable.supplierSkuKey;
  const matches = await reader
    .select({ product: productsTable, alias: supplierProductAliasesTable })
    .from(supplierProductAliasesTable)
    .innerJoin(
      productsTable,
      eq(productsTable.id, supplierProductAliasesTable.productId),
    )
    .where(
      and(
        eq(supplierProductAliasesTable.supplierKey, norm(source.supplier)),
        sql`${codeColumn}=${norm(code)}`,
      ),
    )
    .limit(2);
  if (matches.length !== 1)
    conflict(
      "A historical bill line needs one explicit exact supplier/code/product identity; ambiguous or retargeted codes cannot be inferred.",
    );
  const row = matches[0];
  if (
    !row.product.active ||
    row.product.inventoryType !== "Inventory" ||
    row.product.sku !== line.internalSku ||
    (originalIds &&
      (row.product.id !== originalIds.product ||
        row.alias.id !== originalIds.alias))
  )
    conflict(
      "The bill's original product identity changed or is unavailable. Its historical source has not been rewritten.",
    );
  const [price] = await reader
    .select()
    .from(supplierBuyPricesTable)
    .where(
      and(
        eq(supplierBuyPricesTable.aliasId, row.alias.id),
        eq(supplierBuyPricesTable.effectiveOn, line.priceEffectiveOn),
        lte(supplierBuyPricesTable.effectiveOn, billDate(source)),
        originalIds
          ? eq(supplierBuyPricesTable.id, originalIds.price)
          : undefined,
      ),
    )
    .limit(1);
  if (
    !price ||
    price.effectiveOn !== line.priceEffectiveOn ||
    price.unit !== line.unit ||
    decimal(price.unitCost) !== decimal(line.expectedUnitCost) ||
    (originalIds && price.id !== originalIds.price)
  )
    conflict(
      "The frozen dated supplier price no longer matches the bill evidence; record an operator review rather than repricing its receipt.",
    );
  const factor = line.stockConversion?.unitsPerBuyUnit ?? "1";
  if (
    decimal(price.stockUnitsPerBuyUnit) !== decimal(factor) ||
    (line.stockConversion
      ? line.stockConversion.unit !== row.product.unit
      : line.unit !== row.product.unit)
  )
    conflict(
      "The original purchase-to-stock unit conversion changed. Review the frozen unit evidence.",
    );
  return {
    ...row,
    price,
    binding: originalIds ? "original_preparation" : "owner_reconciled_legacy",
  };
}

async function existingCoverage(
  reader: Reader,
  receiptIds: string[],
  billIds: string[],
) {
  const rows = await reader
    .select()
    .from(allocations)
    .where(
      receiptIds.length
        ? inArray(allocations.receiptLineId, receiptIds)
        : inArray(allocations.billId, billIds),
    );
  const allBindings = rows.length
    ? await reader
        .select()
        .from(bindings)
        .where(
          inArray(
            bindings.allocationId,
            rows.map((row) => row.id),
          ),
        )
    : [];
  return rows.map((row) => {
    const bound = allBindings
      .filter((binding) => binding.allocationId === row.id)
      .reduce((sum, binding) => sum + coverageMicros(binding.quantity), 0n);
    const source = sourceBill.parse(row.billSource);
    return {
      id: row.id,
      approvalId: row.approvalId,
      receiptLineId: row.receiptLineId,
      billId: row.billId,
      billLineIndex: row.billLineIndex,
      productId: row.productId,
      quantity: row.quantity,
      stockUnit: row.stockUnit,
      receiptUnitCost: row.receiptUnitCost,
      billedUnitCost: row.billedUnitCost,
      varianceNote: row.varianceNote,
      createdAt: row.createdAt,
      mode: row.mode,
      sourceBillNumber: billNumber(source),
      providerBoundQuantity: coverageDecimal(bound),
      unboundQuantity: coverageDecimal(coverageMicros(row.quantity) - bound),
    } satisfies CoverageAllocation;
  });
}

export async function loadCoverageEvidence(
  reader: Reader,
  billIds: string[],
  receiptIds?: string[],
  remote?: Remote,
): Promise<Loaded> {
  const rows = await reader
    .select()
    .from(bills)
    .where(
      and(eq(bills.entityType, vendorBillEntity), inArray(bills.id, billIds)),
    )
    .orderBy(asc(bills.id));
  if (rows.length !== billIds.length)
    throw new DomainError(
      404,
      "The selected supplier bills were not found in this company.",
    );
  const evidence = new Map<string, BillEvidence>(),
    providerSources = new Map<string, string>(),
    identities: string[] = [],
    allLines: CoverageBillLine[] = [];
  let mode: CoverageMode | null = null,
    company: CoverageCompany | null = null;
  for (const row of rows) {
    const parsed = sourceBill.safeParse(row.payload);
    if (!parsed.success)
      conflict(
        "This bill does not retain a complete supported original merchandise source.",
      );
    const source = parsed.data,
      nextMode: CoverageMode =
        source.mode === "review" ? "local_review" : "quickbooks_verified";
    if (mode && mode !== nextMode)
      conflict(
        "Local-only reviews and provider-verified bills require separate explicit coverage approvals.",
      );
    mode = nextMode;
    if (source.mode === "review" && row.status !== "reviewed")
      conflict(
        "Finish the original local supplier bill review before matching accepted receipt quantities.",
      );
    if (source.mode !== "review") {
      const [current] = await reader
        .select()
        .from(quickbooksConnectionsTable)
        .where(eq(quickbooksConnectionsTable.status, "connected"))
        .limit(1);
      if (
        !current ||
        source.mode !== current.environment ||
        source.realmId !== current.realmId ||
        row.status !== "completed" ||
        !reference.safeParse(source.postedId).success
      )
        conflict(
          "Connect the exact original company and select a confirmed posted bill; local/simulated records do not become provider evidence.",
        );
      company = {
        connectionId: current.id,
        realmId: current.realmId,
        environment: current.environment as "sandbox" | "production",
        companyName: current.companyName,
      };
      const priorSource = providerSources.get(source.postedId!);
      if (priorSource && priorSource !== row.id)
        conflict(
          "One posted supplier bill must use one immutable original queue source. Duplicate or reordered queue copies need explicit accounting review.",
        );
      providerSources.set(source.postedId!, row.id);
      if (remote && cutoverHash(remote.company) !== cutoverHash(company))
        conflict(
          "The connected company changed before coverage could be recorded.",
        );
    }
    const item: BillEvidence = {
      row,
      source,
      billSource: immutableVendorBillSource(row.payload),
      fingerprint: vendorBillSourceFingerprint(row.payload),
      lines: new Map(),
      provider: null,
    };
    evidence.set(row.id, item);
    for (const [index, line] of source.lines.entries()) {
      const identity = await exactIdentity(reader, source, line);
      item.lines.set(index, identity);
      if (identity.binding === "owner_reconciled_legacy")
        identities.push(
          `Bill ${billNumber(source)}, line ${index + 1}: original product/alias/price IDs were not retained. This approval explicitly binds today's exact identities and preserves the older source; it does not claim original mapping provenance.`,
        );
      const quantity = decimal(line.stockLine?.quantity ?? line.quantity),
        unitCost = decimal(line.stockLine?.unitCost ?? line.billedUnitCost);
      const converted = line.stockConversion
        ? convertedSupplierLine(
            line.quantity,
            line.billedUnitCost,
            line.stockConversion.unitsPerBuyUnit,
          )
        : null;
      if (
        line.stockConversion &&
        (!converted ||
          decimal(converted.quantity) !== quantity ||
          decimal(converted.unitCost) !== unitCost)
      )
        conflict(
          "The frozen conversion does not preserve the printed source line amount and stock units.",
        );
      const roundingSource = line.stockConversion
        ? {
            version: 1 as const,
            buyQuantity: decimal(line.quantity),
            buyUnitCost: decimal(line.billedUnitCost),
            approvedBuyUnitCost: identity.price.unitCost,
            stockUnitsPerBuyUnit: decimal(line.stockConversion.unitsPerBuyUnit),
            approvedStockUnitsPerBuyUnit: identity.price.stockUnitsPerBuyUnit,
            printedLineAmountCents: String(line.totalCents),
            stockQuantity: quantity,
            billedStockUnitCost: unitCost,
          }
        : undefined;
      if (coverageMicros(quantity) <= 0n)
        conflict(
          "Only positive merchandise quantities can be linked to accepted stock receipts.",
        );
      let itemId: string | null = null,
        vendorId: string | null = null;
      if (company) {
        const prepared = item.source.quickBooksBill as PreparedBill | undefined;
        const merchandise = prepared?.Line[index];
        if (
          !prepared ||
          !merchandise ||
          merchandise.DetailType !== "ItemBasedExpenseLineDetail"
        )
          conflict(
            "This bill line no longer identifies a frozen inventory item.",
          );
        itemId = merchandise.ItemBasedExpenseLineDetail.ItemRef.value;
        vendorId = prepared.VendorRef.value;
        const [mapping] = await reader
          .select()
          .from(quickbooksEntityMappingsTable)
          .where(
            and(
              eq(quickbooksEntityMappingsTable.entityType, "item"),
              eq(quickbooksEntityMappingsTable.localId, identity.product.id),
              eq(quickbooksEntityMappingsTable.realmId, company.realmId),
              eq(
                quickbooksEntityMappingsTable.environment,
                company.environment,
              ),
              eq(quickbooksEntityMappingsTable.status, "linked"),
            ),
          )
          .limit(1);
        if (
          mapping?.quickbooksId !== itemId ||
          !reference.safeParse(itemId).success ||
          !reference.safeParse(vendorId).success
        )
          conflict(
            "The current company item mapping differs from this original bill line.",
          );
      }
      allLines.push({
        key: `${row.id}:${index}`,
        billId: row.id,
        billLineIndex: index,
        billNumber: billNumber(source),
        supplier: source.supplier,
        productId: identity.product.id,
        sku: identity.product.sku,
        productName: identity.product.name,
        stockUnit: identity.product.unit,
        quantity,
        unitCost,
        allocatedQuantity: "0.000000",
        remainingQuantity: quantity,
        sourceFingerprint: cutoverHash({
          source: item.billSource,
          lineIndex: index,
          identity,
        }),
        vendorId,
        itemId,
        postedBillId: company ? source.postedId! : null,
        verification: company ? "verified" : "local_only",
        eligible: true,
        blockedReason: null,
        ...(roundingSource ? { roundingSource } : {}),
      });
    }
  }
  if (company) {
    for (const item of evidence.values()) {
      const snapshot =
        remote?.byBill[item.row.id] ??
        (await readProviderBill(
          company,
          item.source,
          allLines.filter((line) => line.billId === item.row.id),
        ));
      if (!snapshot)
        conflict(
          "Provider bill evidence is unavailable; no local review was promoted to confirmed accounting.",
        );
      item.provider = snapshot;
    }
  }
  const productIds = [...new Set(allLines.map((line) => line.productId))];
  const receiptRows = await reader
    .select({
      line: purchaseReceiptLinesTable,
      header: purchaseReceiptsTable,
      order: purchaseOrdersTable,
      orderLine: purchaseOrderLinesTable,
      movement: inventoryMovementsTable,
      product: productsTable,
      warehouse: warehousesTable,
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
      inventoryMovementsTable,
      eq(inventoryMovementsTable.id, purchaseReceiptLinesTable.movementId),
    )
    .innerJoin(
      productsTable,
      eq(productsTable.id, purchaseOrderLinesTable.productId),
    )
    .innerJoin(
      warehousesTable,
      eq(warehousesTable.id, purchaseOrdersTable.warehouseId),
    )
    .where(
      and(
        inArray(productsTable.id, productIds),
        sql`${purchaseReceiptLinesTable.quantity}>0`,
        receiptIds
          ? inArray(purchaseReceiptLinesTable.id, receiptIds)
          : undefined,
      ),
    )
    .orderBy(
      desc(purchaseReceiptsTable.receivedAt),
      asc(purchaseReceiptLinesTable.id),
    )
    .limit(receiptIds ? 101 : 501);
  if (receiptIds && receiptRows.length !== receiptIds.length)
    conflict(
      "The selected accepted receipt sources changed or were not found in this company.",
    );
  const existing = await existingCoverage(
      reader,
      receiptRows.map((row) => row.line.id),
      billIds,
    ),
    rawReceipts = new Map<string, Json>();
  const receipts = receiptRows.slice(0, 500).map((row) => {
    const scaledMovement = Math.round(row.movement.quantity * 1e6);
    if (
      row.order.id !== row.orderLine.orderId ||
      row.movement.kind !== "receipt" ||
      row.movement.productId !== row.product.id ||
      row.orderLine.unit !== row.product.unit ||
      row.movement.acquisitionUnitCost === null ||
      !Number.isSafeInteger(scaledMovement) ||
      BigInt(scaledMovement) !== coverageMicros(row.line.quantity)
    )
      conflict(
        "An accepted receipt does not retain the exact product, stock unit and acquisition movement needed for review.",
      );
    const allocated = existing
      .filter((entry) => entry.receiptLineId === row.line.id)
      .reduce((sum, entry) => sum + coverageMicros(entry.quantity), 0n);
    const snapshot = {
      line: row.line,
      header: row.header,
      order: row.order,
      orderLine: row.orderLine,
      movement: {
        id: row.movement.id,
        productId: row.movement.productId,
        kind: row.movement.kind,
        quantity: row.movement.quantity,
        acquisitionUnitCost: row.movement.acquisitionUnitCost,
        costAllocations: row.movement.costAllocations,
      },
      product: {
        id: row.product.id,
        sku: row.product.sku,
        unit: row.product.unit,
      },
      warehouse: row.warehouse,
    };
    rawReceipts.set(row.line.id, snapshot);
    return {
      id: row.line.id,
      receiptId: row.header.id,
      orderId: row.order.id,
      orderNumber: String(row.order.number),
      reference: row.header.reference,
      supplier: row.order.supplier,
      productId: row.product.id,
      sku: row.product.sku,
      productName: row.product.name,
      warehouseId: row.warehouse.id,
      warehouseName: row.warehouse.name,
      stockUnit: row.product.unit,
      quantity: row.line.quantity,
      unitCost: row.movement.acquisitionUnitCost,
      allocatedQuantity: coverageDecimal(allocated),
      remainingQuantity: coverageDecimal(
        coverageMicros(row.line.quantity) - allocated,
      ),
      sourceFingerprint: cutoverHash(snapshot),
    } satisfies CoverageReceipt;
  });
  const billBindings = await reader
    .select()
    .from(bindings)
    .where(
      company
        ? and(
            eq(bindings.realmId, company.realmId),
            eq(bindings.environment, company.environment),
          )
        : inArray(bindings.billId, billIds),
    );
  const localAllocations = await reader
    .select()
    .from(allocations)
    .where(inArray(allocations.billId, billIds));
  for (const line of allLines) {
    if (
      line.verification === "verified" &&
      billBindings.some(
        (entry) =>
          entry.postedBillId === line.postedBillId &&
          entry.billId !== line.billId,
      )
    )
      conflict(
        "This actual posted bill already uses a different immutable queue source. Review that original source; reordered duplicate copies cannot create new merchandise-line capacity.",
      );
  }
  for (const line of allLines) {
    const used =
      line.verification === "local_only"
        ? localAllocations
            .filter(
              (entry) =>
                entry.billId === line.billId &&
                entry.billLineIndex === line.billLineIndex,
            )
            .reduce((sum, entry) => sum + coverageMicros(entry.quantity), 0n)
        : billBindings
            .filter(
              (entry) =>
                entry.postedBillId === line.postedBillId &&
                entry.billLineIndex === line.billLineIndex,
            )
            .reduce((sum, entry) => sum + coverageMicros(entry.quantity), 0n);
    line.allocatedQuantity = coverageDecimal(used);
    line.remainingQuantity = coverageDecimal(
      coverageMicros(line.quantity) - used,
    );
  }
  return {
    mode: mode!,
    company,
    billRows: rows,
    billEvidence: evidence,
    billLines: allLines,
    receipts,
    receiptRows: rawReceipts,
    existing,
    remote: {
      company,
      byBill: Object.fromEntries(
        [...evidence].flatMap(([id, bill]) =>
          bill.provider ? [[id, bill.provider]] : [],
        ),
      ),
    },
    identityWarnings: identities,
    hasMore: receiptRows.length > 500,
  };
}
const load = loadCoverageEvidence;

async function readProviderBill(
  company: CoverageCompany,
  source: z.infer<typeof sourceBill>,
  lines: CoverageBillLine[],
): Promise<Json> {
  const response = await qboRequest(
    `/bill/${source.postedId}`,
    {},
    company.connectionId,
  );
  if (
    !source.quickBooksBill ||
    !matchesPostedBill(source.quickBooksBill as PreparedBill, response.Bill) ||
    response.Bill?.Id !== source.postedId ||
    (response.Bill.CurrencyRef?.value &&
      response.Bill.CurrencyRef.value !== "USD")
  )
    conflict(
      "QuickBooks no longer contains the exact original supported posted bill; no coverage was recorded.",
    );
  const vendorId = (source.quickBooksBill as PreparedBill).VendorRef.value;
  const vendor = (
    await qboRequest(`/vendor/${vendorId}`, {}, company.connectionId)
  ).Vendor;
  if (vendor?.Id !== vendorId || vendor.Active === false)
    conflict("The original supplier is unavailable in this connected company.");
  const items = [];
  for (const id of [...new Set(lines.map((line) => line.itemId!))]) {
    const item = (await qboRequest(`/item/${id}`, {}, company.connectionId))
      .Item;
    if (
      item?.Id !== id ||
      item.Active === false ||
      item.Type !== "Inventory" ||
      item.TrackQtyOnHand !== true
    )
      conflict(
        "The bill requires an active tracked inventory item in this exact company.",
      );
    items.push({
      Id: item.Id,
      SyncToken: item.SyncToken,
      Active: item.Active,
      Type: item.Type,
      TrackQtyOnHand: item.TrackQtyOnHand,
      Sku: item.Sku,
      Name: item.Name,
      IncomeAccountRef: item.IncomeAccountRef,
      ExpenseAccountRef: item.ExpenseAccountRef,
      AssetAccountRef: item.AssetAccountRef,
    });
  }
  const current = response.Bill;
  return {
    bill: {
      Id: current.Id,
      SyncToken: current.SyncToken,
      DocNumber: current.DocNumber,
      TxnDate: current.TxnDate,
      VendorRef: current.VendorRef,
      Line: current.Line,
      CurrencyRef: current.CurrencyRef,
      PrivateNote: current.PrivateNote,
      LinkedTxn: current.LinkedTxn,
    },
    vendor: {
      Id: vendor.Id,
      SyncToken: vendor.SyncToken,
      Active: vendor.Active,
      DisplayName: vendor.DisplayName,
      CompanyName: vendor.CompanyName,
    },
    items,
  };
}

function prepare(choice: CoverageChoice, loaded: Loaded) {
  let body: ReturnType<typeof previewReceiptBillCoverage>;
  try {
    body = previewReceiptBillCoverage(
      choice,
      loaded.receipts,
      loaded.billLines,
      loaded.existing,
    );
  } catch (error) {
    throw new DomainError(
      409,
      error instanceof Error
        ? error.message
        : "Review the exact source quantities and costs.",
    );
  }
  const source = {
    mode: loaded.mode,
    company: loaded.company,
    bills: [...loaded.billEvidence.values()].map((item) => ({
      id: item.row.id,
      status: item.row.status,
      source: item.billSource,
      identities: [...item.lines],
      provider: item.provider,
    })),
    receipts: [...loaded.receiptRows],
    existing: loaded.existing,
    body,
  };
  return {
    preview: {
      ...body,
      mode: loaded.mode,
      company: loaded.company,
      fingerprint: cutoverHash({ choice, source }),
      observedAt: new Date().toISOString(),
      identityWarnings: loaded.identityWarnings,
      hasHistoricalIdentities: loaded.identityWarnings.length > 0,
    },
    source,
  };
}
export async function previewBillReceiptCoverage(choice: CoverageChoice) {
  const loaded = await load(db, choice.billIds, [
    ...new Set(choice.allocations.map((line) => line.receiptLineId)),
  ]);
  return prepare(choice, loaded).preview;
}
export async function coverageBillStatus(billId: string) {
  const [bill] = await db
    .select()
    .from(bills)
    .where(and(eq(bills.id, billId), eq(bills.entityType, vendorBillEntity)));
  if (!bill)
    throw new DomainError(404, "Supplier bill not found in this company.");
  const mode: CoverageMode =
    bill.payload.mode === "review" ? "local_review" : "quickbooks_verified";
  const coverageAvailable =
    mode === "local_review"
      ? bill.status === "reviewed"
      : bill.status === "completed" &&
        ["sandbox", "production"].includes(String(bill.payload.mode));
  return {
    billId,
    mode,
    coverageAvailable,
    blockedReason: coverageAvailable
      ? null
      : "Finish the real local review or confirm the posted provider bill before allocating receipt evidence.",
    allocations: await existingCoverage(db, [], [billId]),
    documents: await listVendorBillDocuments(billId),
    manualCases: [],
  };
}
export async function coverageOptions(billId: string) {
  const focus = await coverageBillStatus(billId);
  if (!focus.coverageAvailable) conflict(focus.blockedReason!);
  // The focused bill is strict; a retired or different-company alternative must
  // not prevent reviewing a valid source. Bound discovery without fuzzy matches.
  const focused = await load(db, [billId]);
  let validatedRemote = focused.remote;
  const all = await db
    .select()
    .from(bills)
    .where(
      and(
        eq(bills.entityType, vendorBillEntity),
        sql`${bills.payload}->>'mode'=${focus.mode === "local_review" ? "review" : focused.company!.environment}`,
        focused.company
          ? sql`${bills.payload}->>'realmId'=${focused.company.realmId}`
          : undefined,
        sql`lower(btrim(${bills.payload}->>'supplier'))=${norm(focused.billLines[0].supplier)}`,
        sql`${bills.status}=${focus.mode === "local_review" ? "reviewed" : "completed"}`,
      ),
    )
    .orderBy(desc(bills.createdAt), asc(bills.id))
    .limit(41);
  const ids = [billId];
  let omitted = false;
  for (const row of all) {
    if (row.id === billId || ids.length >= 20) continue;
    try {
      const alternative = await load(db, [row.id], undefined, validatedRemote);
      ids.push(row.id);
      validatedRemote = {
        company: alternative.company,
        byBill: { ...validatedRemote.byBill, ...alternative.remote.byBill },
      };
    } catch (error) {
      if (error instanceof DomainError && error.status === 409) omitted = true;
      else throw error;
    }
  }
  const loaded = await load(db, ids, undefined, validatedRemote);
  return {
    mode: loaded.mode,
    company: loaded.company,
    bills: loaded.billLines,
    receipts: loaded.receipts,
    allocations: loaded.existing,
    documents: focus.documents,
    manualCases: [],
    observedAt: new Date().toISOString(),
    hasMore: all.length > 20 || loaded.hasMore || omitted,
  };
}

async function lockSources(
  tx: CoverageTransaction,
  choice: CoverageChoice,
  loaded: Loaded,
) {
  if (loaded.company)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
  const receipts = [
    ...new Set(choice.allocations.map((line) => line.receiptLineId)),
  ].sort();
  await tx
    .select({ id: purchaseReceiptLinesTable.id })
    .from(purchaseReceiptLinesTable)
    .where(inArray(purchaseReceiptLinesTable.id, receipts))
    .orderBy(asc(purchaseReceiptLinesTable.id))
    .for("update");
  const originalBillIds = loaded.existing
    .filter((row) =>
      choice.allocations.some((line) => line.existingAllocationId === row.id),
    )
    .map((row) => row.billId);
  await tx
    .select({ id: bills.id })
    .from(bills)
    .where(
      inArray(
        bills.id,
        [...new Set([...choice.billIds, ...originalBillIds])].sort(),
      ),
    )
    .orderBy(asc(bills.id))
    .for("update");
  const identities = [...loaded.billEvidence.values()].flatMap((item) => [
    ...item.lines.values(),
  ]);
  for (const [table, ids] of [
    [
      productsTable,
      [...new Set(identities.map((row) => row.product.id))].sort(),
    ],
    [
      supplierProductAliasesTable,
      [...new Set(identities.map((row) => row.alias.id))].sort(),
    ],
    [
      supplierBuyPricesTable,
      [...new Set(identities.map((row) => row.price.id))].sort(),
    ],
  ] as const)
    await tx
      .select({ id: table.id })
      .from(table)
      .where(inArray(table.id, ids))
      .orderBy(asc(table.id))
      .for("share");
  if (loaded.company)
    await tx.execute(sql`LOCK TABLE quickbooks_entity_mappings IN SHARE MODE`);
  if (loaded.company)
    await tx
      .select({ id: quickbooksConnectionsTable.id })
      .from(quickbooksConnectionsTable)
      .where(eq(quickbooksConnectionsTable.id, loaded.company.connectionId))
      .for("share");
}
export async function approveBillReceiptCoverage(
  choice: CoverageChoice,
  fingerprint: string,
  requestKey: string,
  actor: string,
) {
  const requestFingerprint = cutoverHash({ choice, fingerprint });
  const [prior] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.requestKey, requestKey));
  if (prior) {
    await db.transaction((tx) => assertCoverageOwner(tx, actor));
    if (prior.requestFingerprint !== requestFingerprint)
      conflict(
        "This request key belongs to a different immutable receipt/bill approval.",
      );
    return {
      id: prior.id,
      requestKey,
      fingerprint: prior.fingerprint,
      allocations: await existingCoverage(db, [], choice.billIds),
      createdAt: prior.createdAt,
      replayed: true,
    };
  }
  const loaded = await load(db, choice.billIds, [
    ...new Set(choice.allocations.map((line) => line.receiptLineId)),
  ]);
  if (prepare(choice, loaded).preview.fingerprint !== fingerprint)
    conflict(
      "The receipt, bill, mappings, price or current provider evidence changed. Preview the exact sources again.",
    );
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${"vendor-bill-coverage:" + requestKey},0))`,
    );
    await lockSources(tx, choice, loaded);
    await assertCoverageOwner(tx, actor);
    const [duplicate] = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.requestKey, requestKey));
    if (duplicate) {
      if (duplicate.requestFingerprint !== requestFingerprint)
        conflict("This request key belongs to another immutable approval.");
      return {
        id: duplicate.id,
        requestKey,
        fingerprint: duplicate.fingerprint,
        allocations: await existingCoverage(tx, [], choice.billIds),
        createdAt: duplicate.createdAt,
        replayed: true,
      };
    }
    const current = await load(
        tx,
        choice.billIds,
        [...new Set(choice.allocations.map((line) => line.receiptLineId))],
        loaded.remote,
      ),
      prepared = prepare(choice, current);
    if (prepared.preview.fingerprint !== fingerprint)
      conflict(
        "The reviewed source changed while waiting for the source locks. No quantity coverage was recorded.",
      );
    const at = new Date().toISOString(),
      id = randomUUID();
    await tx.insert(approvals).values({
      id,
      requestKey,
      requestFingerprint,
      fingerprint,
      mode: current.mode,
      workspaceKey: workspaceScopeKey() || "default",
      connectionId: current.company?.connectionId ?? null,
      realmId: current.company?.realmId ?? null,
      environment: current.company?.environment ?? null,
      choice: choice as unknown as Json,
      sourceSnapshot: prepared.source,
      note: choice.note,
      createdBy: actor,
      createdAt: at,
    });
    for (const line of prepared.preview.lines) {
      const evidence = current.billEvidence.get(line.billId)!,
        identity = evidence.lines.get(line.billLineIndex)!;
      const retainedIdentity = {
        ...identity,
        varianceClassification: line.varianceClassification,
        ...(line.roundingEvidence
          ? { roundingEvidence: line.roundingEvidence }
          : {}),
      };
      const retainedVarianceNote =
        line.varianceNote ||
        (line.varianceClassification === "unit_conversion_rounding"
          ? "Documented purchase-unit conversion rounding; exact source proof retained."
          : "");
      let allocationId = line.existingAllocationId;
      if (!allocationId) {
        allocationId = randomUUID();
        await tx.insert(allocations).values({
          id: allocationId,
          approvalId: id,
          receiptLineId: line.receiptLineId,
          billId: line.billId,
          billLineIndex: line.billLineIndex,
          productId: line.receipt.productId,
          aliasId: identity.alias.id,
          priceId: identity.price.id,
          mode: current.mode,
          stockUnit: line.receipt.stockUnit,
          quantity: line.quantity,
          receiptUnitCost: line.receipt.unitCost,
          billedUnitCost: line.bill.unitCost,
          billLineQuantity: line.bill.quantity,
          billSource: evidence.billSource,
          billSourceFingerprint: evidence.fingerprint,
          receiptSnapshot: current.receiptRows.get(line.receiptLineId)!,
          identitySnapshot: retainedIdentity as unknown as Json,
          varianceNote: retainedVarianceNote,
          createdAt: at,
        });
      }
      if (current.company) {
        await tx.insert(bindings).values({
          id: randomUUID(),
          approvalId: id,
          allocationId,
          billId: line.billId,
          billLineIndex: line.billLineIndex,
          connectionId: current.company.connectionId,
          realmId: current.company.realmId,
          environment: current.company.environment,
          vendorId: line.bill.vendorId!,
          itemId: line.bill.itemId!,
          postedBillId: line.bill.postedBillId!,
          quantity: line.quantity,
          billLineQuantity: line.bill.quantity,
          billedUnitCost: line.bill.unitCost,
          billSource: evidence.billSource,
          billSourceFingerprint: evidence.fingerprint,
          providerSnapshot: evidence.provider!,
          identitySnapshot: retainedIdentity as unknown as Json,
          varianceNote: retainedVarianceNote,
          reconciliationNote: line.reconciliationNote?.trim() ?? "",
          createdAt: at,
        });
      }
    }
    await tx.insert(auditEventsTable).values({
      id: randomUUID(),
      actorUserId: actor,
      action: "vendor_bill.receipt_coverage_approved",
      entityType: "vendor_bill_coverage",
      entityId: id,
      details: {
        fingerprint,
        mode: current.mode,
        allocationCount: prepared.preview.lines.length,
        stockChanged: false,
        providerWrite: false,
      },
      createdAt: at,
    });
    return {
      id,
      requestKey,
      fingerprint,
      allocations: await existingCoverage(tx, [], choice.billIds),
      createdAt: at,
      replayed: false,
    };
  });
}
