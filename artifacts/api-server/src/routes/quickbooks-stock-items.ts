import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import {
  db,
  productsTable,
  quickbooksEntityMappingsTable,
  quickbooksSyncJobsTable,
} from "@workspace/db";
import { audit } from "../lib/auth";
import { domainRoute, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { getConnection, qboQuery, qboRequest } from "../lib/quickbooks";
import {
  exportSandboxStockItem,
  findSandboxStockItem,
  inventorySandboxAvailable,
  prepareSandboxStockItem,
  sandboxStockItemEntity,
  sandboxStockItemInput,
} from "../lib/quickbooks-stock-item";
import { requireOwner } from "../middlewares/auth";

const router = Router();
const path = "/quickbooks/sandbox-stock-items";
const links = quickbooksEntityMappingsTable;
const queue = quickbooksSyncJobsTable;
type Input = z.infer<typeof sandboxStockItemInput>;

async function context(input: Input) {
  const connection = await getConnection();
  if (
    !connection ||
    !inventorySandboxAvailable(connection) ||
    connection.id !== input.connectionId
  )
    throw new DomainError(
      409,
      "Connect and reconcile the intended QuickBooks sandbox before reviewing an inventory item.",
    );
  const [product] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, input.productId))
    .limit(1);
  if (!product) throw new DomainError(404, "Product not found.");
  const duplicateSku = await db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(
      and(
        ne(productsTable.id, product.id),
        eq(
          sql<string>`lower(btrim(${productsTable.sku}))`,
          product.sku.trim().toLowerCase(),
        ),
      ),
    )
    .limit(1);
  if (duplicateSku.length)
    throw new DomainError(
      409,
      "The internal SKU belongs to multiple products. Resolve that collision before sandbox export.",
    );
  const getLink = async (reader: Pick<typeof db, "select">) => {
    const [link] = await reader
      .select()
      .from(links)
      .where(and(eq(links.entityType, "item"), eq(links.localId, product.id)))
      .limit(1);
    if (
      link &&
      (link.status !== "linked" ||
        link.environment !== "sandbox" ||
        link.realmId !== connection.realmId)
    )
      throw new DomainError(
        409,
        "Reconcile the existing product mapping before creating a sandbox item.",
      );
    return link;
  };
  const link = await getLink(db);
  const provider = {
    request: (target: string, init?: RequestInit) =>
      qboRequest(target, init, connection.id),
    query: (statement: string) => qboQuery(statement, connection.id),
  };
  const prepared = await prepareSandboxStockItem(
    product,
    connection.realmId,
    input,
    provider,
  ).catch((error: Error) => {
    throw new DomainError(409, error.message);
  });
  return { product, prepared, provider, link, getLink };
}

router.post(
  `${path}/preview`,
  requireOwner,
  domainRoute(async (req, res) => {
    const input = parse(sandboxStockItemInput.strict(), req.body);
    const { prepared, provider, link } = await context(input);
    const existing = await findSandboxStockItem(prepared, provider).catch(
      (error: Error) => {
        throw new DomainError(409, error.message);
      },
    );
    if (link && link.quickbooksId !== existing?.Id)
      throw new DomainError(
        409,
        "The sandbox item differs from the saved product link. Reconcile the existing product first.",
      );
    res.json({ ...prepared, existingItemId: existing?.Id ?? null });
  }),
);

router.post(
  `${path}/approve`,
  requireOwner,
  domainRoute(async (req, res) => {
    const { fingerprint, ...input } = parse(
      sandboxStockItemInput
        .extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
      req.body,
    );
    const { product, prepared, provider, link, getLink } = await context(input);
    if (fingerprint !== prepared.fingerprint)
      throw new DomainError(
        409,
        "The product or accounts changed after review. Preview them again before approving.",
      );
    const actor = req.auth!.userId;
    const key = `sandbox-stock-item:${prepared.realmId}:${product.id}`;
    const now = new Date().toISOString();
    const attempt = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, product.id))
        .for("update");
      if (
        !current ||
        current.name !== product.name ||
        current.sku !== product.sku ||
        !current.active ||
        current.inventoryType !== "Inventory"
      )
        throw new DomainError(
          409,
          "The stocked product changed. Review it before approving.",
        );
      const [prior] = await tx
        .select()
        .from(queue)
        .where(eq(queue.idempotencyKey, key))
        .limit(1);
      if (prior) {
        if (prior.payload.fingerprint !== fingerprint)
          throw new DomainError(
            409,
            "A previous attempt used different details. Reconcile the sandbox item before starting another export.",
          );
        if (prior.status === "completed") return prior;
        if (
          prior.status === "processing" &&
          prior.startedAt &&
          Date.now() - Date.parse(prior.startedAt) < 300_000
        )
          throw new DomainError(
            409,
            "An approved export is already in progress for this product.",
          );
        const [updated] = await tx
          .update(queue)
          .set({
            status: "processing",
            startedAt: now,
            updatedAt: now,
            lastError: null,
            attempts: prior.attempts + 1,
          })
          .where(eq(queue.id, prior.id))
          .returning();
        return updated;
      }
      const [newAttempt] = await tx
        .insert(queue)
        .values({
          id: randomUUID(),
          idempotencyKey: key,
          entityType: sandboxStockItemEntity,
          localId: product.id,
          action: "create",
          payload: prepared,
          status: "processing",
          attempts: 1,
          approvedBy: actor,
          approvedAt: now,
          startedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return newAttempt;
    });
    if (attempt.status === "completed") {
      res.json(attempt.payload.result);
      return;
    }

    try {
      const { item, reconciledExisting } = await exportSandboxStockItem(
        prepared,
        provider,
        link?.quickbooksId,
      );
      const result = { itemId: item.Id, sku: item.Sku, reconciledExisting };
      const completed = new Date().toISOString();
      await db.transaction(async (tx) => {
        const current = await getLink(tx);
        if (current && current.quickbooksId !== item.Id)
          throw new DomainError(
            409,
            "A different product link was saved while the sandbox export was running. Reconcile before retrying.",
          );
        const [other] = await tx
          .select({ id: links.id })
          .from(links)
          .where(
            and(
              eq(links.entityType, "item"),
              eq(links.status, "linked"),
              eq(links.environment, "sandbox"),
              eq(links.realmId, prepared.realmId),
              eq(links.quickbooksId, item.Id),
              ne(links.localId, product.id),
            ),
          )
          .limit(1);
        if (other)
          throw new DomainError(
            409,
            "Another product is already linked to this sandbox item. Reconcile the saved links.",
          );
        if (!current) {
          await tx.insert(links).values({
            id: randomUUID(),
            entityType: "item",
            localId: product.id,
            quickbooksId: item.Id,
            syncToken: item.SyncToken,
            realmId: prepared.realmId,
            environment: "sandbox",
            status: "linked",
            fingerprint,
            createdAt: completed,
            updatedAt: completed,
            lastSyncedAt: completed,
          });
        }
        await tx
          .update(queue)
          .set({
            status: "completed",
            payload: { ...prepared, result },
            completedAt: completed,
            updatedAt: completed,
          })
          .where(eq(queue.id, attempt.id));
      });
      await audit("quickbooks.sandbox_stock_item_linked", {
        userId: actor,
        entityType: "item",
        entityId: product.id,
        details: result,
      });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "QuickBooks inventory item export failed.";
      await db
        .update(queue)
        .set({
          status: "failed",
          lastError: message,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(queue.id, attempt.id),
            eq(queue.status, "processing"),
            eq(queue.attempts, attempt.attempts),
          ),
        );
      throw new DomainError(409, message);
    }
  }),
);

export default router;
