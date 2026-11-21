import { workspaceEnvironment } from "@workspace/db/workspace";
import { createHash, randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { supplierPurchaseFactor } from "@workspace/domain";
import {
  db,
  productsTable,
  quickbooksEntityMappingsTable,
  quickbooksSyncJobsTable,
  supplierBuyPricesTable,
  supplierProductAliasesTable,
} from "@workspace/db";
import { domainRoute, id, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { getConnection, qboQuery, qboRequest } from "../lib/quickbooks";
import {
  buildVendorBill,
  confirmProductionVendorBill,
  productionVendorBillsAvailable,
  readQuickBooksBillChargeAccounts,
  readQuickBooksVendorBillTarget,
  reviewVendorBill,
  reconcileQuickBooksVendorBill,
  vendorBillEntity,
  queuedVendorBillInput,
  vendorBillInput,
  vendorBillMode,
  type VendorBillInput,
} from "../lib/vendor-bill";
import { requireOwner } from "../middlewares/auth";

const router: IRouter = Router();
const basePath = "/quickbooks/vendor-bills";
const queue = quickbooksSyncJobsTable;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalized = (value: string) => value.trim().toLowerCase();
type Context =
  | { mode: "review" }
  | { mode: "simulated" }
  | { mode: "sandbox"; realmId: string; connectionId: string }
  | { mode: "production"; realmId: string; connectionId: string };

async function billContext(
  mode: VendorBillInput["mode"],
  realmId?: string,
): Promise<Context> {
  if (mode === "review") {
    if (workspaceEnvironment().DEMO_MODE === "true") {
      throw new DomainError(
        409,
        "Local supplier bill reviews are available outside demo mode.",
      );
    }
    return { mode };
  }
  const connection = await getConnection();
  if (mode === "production") {
    if (
      !connection ||
      !productionVendorBillsAvailable(connection) ||
      (realmId !== undefined && realmId !== connection.realmId)
    ) {
      throw new DomainError(
        409,
        "QuickBooks bill posting is unavailable for this company. Verify the production connection and bill export settings.",
      );
    }
    return { mode, realmId: connection.realmId, connectionId: connection.id };
  }
  if (
    mode === "simulated" &&
    workspaceEnvironment().DEMO_MODE === "true" &&
    connection?.status !== "connected"
  )
    return { mode };
  if (
    mode === "sandbox" &&
    workspaceEnvironment().QUICKBOOKS_ENVIRONMENT === "sandbox" &&
    connection?.environment === "sandbox" &&
    connection.status === "connected" &&
    (!realmId || realmId === connection.realmId)
  ) {
    return { mode, realmId: connection.realmId, connectionId: connection.id };
  }
  throw new DomainError(
    409,
    "This bill requires its original QuickBooks sandbox or the disconnected simulator.",
  );
}

async function prepare(input: VendorBillInput, context: Context) {
  const catalog = !input.lines.length ? [] : await db
    .select({ alias: supplierProductAliasesTable, product: productsTable })
    .from(supplierProductAliasesTable)
    .innerJoin(
      productsTable,
      eq(supplierProductAliasesTable.productId, productsTable.id),
    )
    .where(
      and(
        eq(supplierProductAliasesTable.supplierKey, normalized(input.supplier)),
        inArray(
          supplierProductAliasesTable.supplierSkuKey,
          input.lines.map((line) => normalized(line.supplierSku)),
        ),
      ),
    );
  if (input.lines.length && !catalog.length)
    throw new DomainError(
      409,
      "Approve the supplier SKUs in Inventory before reviewing this bill.",
    );
  const rates = !catalog.length ? [] : await db
    .selectDistinctOn([supplierBuyPricesTable.aliasId])
    .from(supplierBuyPricesTable)
    .where(
      and(
        inArray(
          supplierBuyPricesTable.aliasId,
          catalog.map(({ alias }) => alias.id),
        ),
        lte(supplierBuyPricesTable.effectiveOn, input.billDate),
      ),
    )
    .orderBy(
      supplierBuyPricesTable.aliasId,
      desc(supplierBuyPricesTable.effectiveOn),
    );
  const prices = new Map(rates.map((rate) => [rate.aliasId, rate]));
  const aliases = new Map(
    catalog.map((row) => [row.alias.supplierSkuKey, row]),
  );
  const itemMapping = quickbooksEntityMappingsTable;
  const itemLinks =
    catalog.length && (context.mode === "sandbox" || context.mode === "production")
      ? await db
          .select()
          .from(itemMapping)
          .where(
            and(
              eq(itemMapping.entityType, "item"),
              eq(itemMapping.status, "linked"),
              eq(itemMapping.realmId, context.realmId),
              eq(itemMapping.environment, context.mode),
              inArray(
                itemMapping.localId,
                catalog.map(({ product }) => product.id),
              ),
            ),
          )
      : [];
  const items = new Map(
    itemLinks.map((link) => [link.localId, link.quickbooksId]),
  );
  const reviewedMappings = input.lines.map((line) => {
    const row = aliases.get(normalized(line.supplierSku));
    const price = row && prices.get(row.alias.id);
    const factor = row && price ? supplierPurchaseFactor(price.unit, row.product.unit, price.stockUnitsPerBuyUnit) : null;
    if (
      !row?.product.active ||
      !price ||
      !factor
    ) {
      throw new DomainError(
        409,
        `An active product and approved dated purchase price are required for ${line.supplierSku}.`,
      );
    }
    return {
      productId: row.product.id,
      line: {
        supplierSku: row.alias.supplierSku,
        productName: row.product.name,
        internalSku: row.product.sku,
        unit: price.unit,
        expectedUnitCost: price.unitCost,
        priceEffectiveOn: price.effectiveOn,
        priceSource: price.source,
        ...(normalized(row.product.unit) === normalized(price.unit) ? {} : {
          stockConversion: { unit: row.product.unit, unitsPerBuyUnit: factor },
        }),
      },
    };
  });
  if (context.mode === "review") {
    return {
      ...reviewVendorBill(
        input,
        reviewedMappings.map(({ line }) => line),
      ),
      billNumber: input.billNumber,
      billDate: input.billDate,
      mode: context.mode,
    } as const;
  }
  const mappings = reviewedMappings.map(({ productId, line }) => {
    const itemId =
      context.mode === "simulated" ? `SIM-${productId}` : items.get(productId);
    if (
      !itemId ||
      (context.mode !== "simulated" && !/^\d{1,30}$/.test(itemId))
    ) {
      throw new DomainError(
        409,
        `Link ${line.internalSku} to an item in the connected QuickBooks company through Import & reconcile.`,
      );
    }
    return { ...line, quickBooksItemId: itemId };
  });
  if (context.mode !== "simulated" && !input.vendorId)
    throw new DomainError(
      400,
      "Enter the vendor ID from the connected QuickBooks company.",
    );
  if (context.mode === "simulated" && input.charges?.length)
    throw new DomainError(409, "Account charges are reviewed locally or verified in a connected QuickBooks company.");
  const prepared = buildVendorBill(
    input,
    mappings,
    context.mode === "simulated" ? "SIM-VENDOR" : input.vendorId!,
  );
  if (context.mode === "simulated")
    return { ...prepared, mode: context.mode } as const;
  try {
    const request = (path: string) => qboRequest(path, {}, context.connectionId);
    const accountIds = prepared.quickBooksBill.Line.flatMap((line) => line.DetailType === "AccountBasedExpenseLineDetail" ? [line.AccountBasedExpenseLineDetail.AccountRef.value] : []);
    const chargeAccounts = accountIds.length ? await readQuickBooksBillChargeAccounts(accountIds, request) : undefined;
    const details = chargeAccounts ? { chargeAccounts } : {};
    if (context.mode === "production") {
      const target = await readQuickBooksVendorBillTarget(input.vendorId!, request);
      if (!target.vendorName)
        throw new Error("QuickBooks did not return a vendor name to review.");
      return {
        ...prepared,
        ...details,
        mode: context.mode,
        realmId: context.realmId,
        quickBooksTarget: target,
      } as const;
    }
    return { ...prepared, ...details, mode: context.mode, realmId: context.realmId } as const;
  } catch (error) {
    throw new DomainError(
      409,
      error instanceof Error ? error.message : "QuickBooks vendor or expense account verification failed.",
    );
  }
}

type BillPayload = Awaited<ReturnType<typeof prepare>> & {
  fingerprint: string;
  postedId?: string;
  reconciledExisting?: boolean;
};

router.get(
  `${basePath}/capabilities`,
  requireOwner,
  domainRoute(async (_req, res) => {
    const connection = await getConnection();
    res.json({
      productionEnabled: productionVendorBillsAvailable(connection),
      companyName: connection?.companyName || null,
      companyId: connection?.realmId || null,
    });
  }),
);

router.get(
  basePath,
  requireOwner,
  domainRoute(async (req, res) => {
    const { mode } = parse(
      z.object({ mode: vendorBillMode.optional() }),
      req.query,
    );
    const context = mode === "production" ? await billContext(mode) : null;
    const productionRealm =
      context?.mode === "production" ? context.realmId : null;
    const rows = await db
      .select()
      .from(queue)
      .where(
        and(
          eq(queue.entityType, vendorBillEntity),
          mode ? sql`${queue.payload}->>'mode' = ${mode}` : undefined,
          productionRealm
            ? sql`${queue.payload}->>'realmId' = ${productionRealm}`
            : undefined,
        ),
      )
      .orderBy(desc(queue.createdAt))
      .limit(20);
    res.json(rows);
  }),
);

router.post(
  `${basePath}/preview`,
  requireOwner,
  domainRoute(async (req, res) => {
    const input = parse(vendorBillInput, req.body);
    const prepared = await prepare(input, await billContext(input.mode));
    res.json({ ...prepared, fingerprint: hash(prepared) });
  }),
);

router.post(
  basePath,
  requireOwner,
  domainRoute(async (req, res) => {
    const input = parse(queuedVendorBillInput, req.body);
    const context = await billContext(input.mode);
    const prepared = await prepare(input, context);
    if (input.fingerprint !== hash(prepared))
      throw new DomainError(
        409,
        "The bill or its mappings changed since preview. Review the details again.",
      );

    const counterparty =
      prepared.mode === "sandbox" || prepared.mode === "production"
        ? [prepared.realmId, prepared.quickBooksBill.VendorRef.value]
        : [normalized(prepared.supplier)];
    const localId = hash([
      context.mode,
      ...counterparty,
      normalized(input.billNumber),
    ]);
    const idempotencyKey = `vendor-bill:${localId}`;
    const now = new Date().toISOString();
    const [created] = await db
      .insert(queue)
      .values({
        id: randomUUID(),
        idempotencyKey,
        entityType: vendorBillEntity,
        localId,
        action: prepared.mode === "review" ? "review" : "create",
        status: "pending_approval",
        payload: { ...prepared, fingerprint: input.fingerprint },
        warnings: prepared.priceDiffers
          ? ["The billed unit cost differs from an approved supplier price."]
          : [],
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      res.status(201).json(created);
      return;
    }
    const [existing] = await db
      .select()
      .from(queue)
      .where(eq(queue.idempotencyKey, idempotencyKey));
    if (existing?.payload.fingerprint !== input.fingerprint)
      throw new DomainError(
        409,
        "A different bill is already queued for this supplier bill number.",
      );
    res.json(existing);
  }),
);

router.post(
  `${basePath}/:id/approve`,
  requireOwner,
  domainRoute(async (req, res) => {
    const [bill] = await db
      .select()
      .from(queue)
      .where(
        and(eq(queue.id, id(req)), eq(queue.entityType, vendorBillEntity)),
      );
    if (!bill) throw new DomainError(404, "Supplier bill not found.");
    if (
      bill.status === "completed" ||
      bill.status === "demo_completed" ||
      bill.status === "reviewed"
    ) {
      res.json(bill);
      return;
    }
    const payload = bill.payload as BillPayload;
    if (payload.mode === "production")
      confirmProductionVendorBill(req.body, payload.fingerprint);
    const now = new Date().toISOString();
    if (payload.mode === "review") {
      await billContext("review");
      const [reviewed] = await db
        .update(queue)
        .set({
          status: "reviewed",
          approvedBy: req.auth!.userId,
          approvedAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .where(and(eq(queue.id, bill.id), eq(queue.status, "pending_approval")))
        .returning();
      if (reviewed) {
        res.json(reviewed);
        return;
      }
      const [current] = await db
        .select()
        .from(queue)
        .where(eq(queue.id, bill.id));
      if (current?.status !== "reviewed") {
        throw new DomainError(
          409,
          "Review the current supplier bill status before retrying.",
        );
      }
      res.json(current);
      return;
    }
    const context = await billContext(
      payload.mode,
      payload.mode === "sandbox" || payload.mode === "production"
        ? payload.realmId
        : undefined,
    );
    if (context.mode === "review")
      throw new DomainError(
        409,
        "Review the original supplier bill mode before retrying.",
      );
    const stuck =
      bill.status === "processing" &&
      !!bill.startedAt &&
      Date.parse(bill.startedAt) < Date.now() - 300_000;
    if (
      bill.status !== "pending_approval" &&
      bill.status !== "failed" &&
      !stuck
    )
      throw new DomainError(409, "This bill is already being processed.");
    const [claimed] = await db
      .update(queue)
      .set({
        status: "processing",
        approvedBy: bill.approvedBy ?? req.auth!.userId,
        approvedAt: bill.approvedAt ?? now,
        startedAt: now,
        updatedAt: now,
        attempts: bill.attempts + 1,
        lastError: null,
      })
      .where(
        and(
          eq(queue.id, bill.id),
          eq(queue.status, bill.status),
          eq(queue.attempts, bill.attempts),
        ),
      )
      .returning();
    if (!claimed)
      throw new DomainError(409, "Another request already approved this bill.");

    try {
      const posted =
        context.mode === "simulated"
          ? {
              postedId: `SIM-BILL-${bill.id.slice(0, 8)}`,
              reconciledExisting: false,
            }
          : await reconcileQuickBooksVendorBill(
              payload.quickBooksBill,
              bill.id,
              {
                request: (path, init) =>
                  qboRequest(path, init, context.connectionId),
                query: (statement) => qboQuery(statement, context.connectionId),
              },
              payload.mode === "production"
                ? payload.quickBooksTarget
                : undefined,
              "chargeAccounts" in payload ? payload.chargeAccounts : undefined,
            );
      const completedAt = new Date().toISOString();
      const [completed] = await db
        .update(queue)
        .set({
          status: context.mode === "simulated" ? "demo_completed" : "completed",
          payload: { ...payload, ...posted },
          completedAt,
          updatedAt: completedAt,
        })
        .where(and(eq(queue.id, bill.id), eq(queue.attempts, claimed.attempts)))
        .returning();
      if (!completed)
        throw new DomainError(
          409,
          "Review the current supplier bill status before retrying.",
        );
      res.json(completed);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The QuickBooks bill did not reconcile.";
      const [failed] = await db
        .update(queue)
        .set({
          status: "failed",
          lastError: message,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(queue.id, bill.id), eq(queue.attempts, claimed.attempts)))
        .returning();
      if (!failed)
        throw new DomainError(
          409,
          "Review the current supplier bill status before retrying.",
        );
      res.status(502).json({ error: message });
    }
  }),
);

export default router;
