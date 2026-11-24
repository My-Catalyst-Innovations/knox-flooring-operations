import { domainRoute, parse } from "../lib/domain-http";
import { DomainError, assertRevision } from "../lib/operations-rules";
import { requireRole } from "../middlewares/auth";
import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { catalogImportMaxBytes } from "@workspace/domain";
import { db, productsTable, inventoryMovementsTable, inventoryReservationsTable, jobMaterialsTable, materialUsageTable, quickbooksSyncJobsTable, warehousesTable, type ProductInsert } from "@workspace/db";
import {
  ListProductsResponse,
  CreateProductBody,
  UpdateProductParams,
  UpdateProductBody,
  UpdateProductResponse,
  DeleteProductParams,
} from "@workspace/api-zod";
import { stripNulls } from "../lib/strip-nulls";
import { queueQuickBooksReview, quickBooksReviewRow } from "../lib/quickbooks-queue";
import { catalogKey, catalogSkuLock, planCatalogImport } from "../lib/catalog-import";
import { assertOwnedFile, externalImageUrl } from "../lib/file-store";

const router: IRouter = Router();
const importCsv = z.string().min(1).max(catalogImportMaxBytes).refine((value) => Buffer.byteLength(value, "utf8") <= catalogImportMaxBytes);
const importRequest = z.object({ csv: importCsv });
const confirmImportRequest = importRequest.extend({ previewKey: z.string().regex(/^[0-9a-f]{64}$/) });
const catalogLockQuery = sql`select pg_advisory_xact_lock(hashtext(${catalogSkuLock}))`;
type CatalogReader = Pick<typeof db, "select">;

async function readCatalogSkus(reader: CatalogReader) {
  return reader.select({ id: productsTable.id, sku: productsTable.sku }).from(productsTable);
}

async function readImportPlan(reader: CatalogReader, csv: string) {
  const [products, warehouses] = await Promise.all([
    readCatalogSkus(reader),
    reader.select({ id: warehousesTable.id, name: warehousesTable.name }).from(warehousesTable),
  ]);
  return planCatalogImport(csv, products, warehouses);
}

async function assertSkuAvailable(reader: CatalogReader, sku: string) {
  if ((await readCatalogSkus(reader)).some((product) => catalogKey(product.sku) === catalogKey(sku))) {
    throw new DomainError(409, "This internal SKU is already assigned to a product.");
  }
}

function validatePackMetadata(data: { coveragePerUnit?: number | null; orderMultiple?: number | null; minimumOrderQty?: number | null; reorderPoint?: number | null }) {
  for (const key of ["coveragePerUnit", "orderMultiple"] as const) if (data[key] != null && (!Number.isFinite(data[key]) || data[key]! <= 0)) throw new DomainError(400, "Coverage and order multiples must be positive when configured.");
  for (const key of ["minimumOrderQty", "reorderPoint"] as const) if (data[key] != null && (!Number.isFinite(data[key]) || data[key]! < 0)) throw new DomainError(400, "Minimum order and reorder thresholds cannot be negative.");
}

router.get("/products", async (_req, res): Promise<void> => {
  const products = await db.select().from(productsTable);
  res.json(ListProductsResponse.parse(products.map(stripNulls)));
});

router.post("/products/catalog-import/preview", requireRole("owner", "operations"), domainRoute(async (req, res) => {
  const { csv } = parse(importRequest, req.body);
  res.json((await readImportPlan(db, csv)).preview);
}));

router.post("/products/catalog-import", requireRole("owner", "operations"), domainRoute(async (req, res) => {
  const { csv, previewKey } = parse(confirmImportRequest, req.body);
  const created = await db.transaction(async (tx) => {
    await tx.execute(catalogLockQuery);
    const { products, preview } = await readImportPlan(tx, csv);
    if (preview.previewKey !== previewKey) throw new DomainError(409, "The catalog changed. Preview the file again before importing.");
    if (preview.errors.length || preview.rows.some((row) => row.status === "error")) {
      throw new DomainError(400, "Correct the rows marked in the preview before importing.");
    }
    if (!products.length) return 0;

    const now = new Date().toISOString();
    const entries = products.map(({ details, balances }) => ({
      product: {
        ...details,
        id: randomUUID(),
        inventoryType: "Inventory",
        quantityOnHand: balances.reduce((total, balance) => total + balance.quantity, 0),
        createdAt: now,
        updatedAt: now,
      },
      balances: balances.length ? balances : [{ warehouseId: null, quantity: 0 }],
    }));
    const saved = await tx.insert(productsTable).values(entries.map(({ product }) => product)).returning();
    await tx.insert(inventoryMovementsTable).values(entries.flatMap(({ product, balances }) => balances.map(({ warehouseId, quantity }) => ({
      id: randomUUID(),
      productId: product.id,
      warehouseId,
      kind: "opening",
      quantity,
      reason: "Opening balance from catalog import",
      actorUserId: req.auth!.userId,
      idempotencyKey: `opening:${product.id}:${warehouseId ?? "unassigned"}`,
      createdAt: now,
    }))));
    await tx.insert(quickbooksSyncJobsTable).values(saved.map((product) => quickBooksReviewRow(
      "item", product.id, "create", stripNulls(product), ["An approved QuickBooks income account is required"], now,
    )));
    return saved.length;
  });
  res.status(created ? 201 : 200).json({ created });
}));

router.post("/products", requireRole("owner", "operations"), domainRoute(async (req, res) => {
  const parsed = CreateProductBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ diagnostic: "request_validation_failed" }, "Invalid product body");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const now = new Date().toISOString();
  const values: ProductInsert = {
    ...parsed.data,
    sku: parsed.data.sku?.trim(),
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };

  validatePackMetadata(parsed.data);
  if (values.imageUrl && !externalImageUrl(values.imageUrl)) {
    await assertOwnedFile(values.imageUrl, ["product-image"], req.auth!.userId, "");
  }
  const product = await db.transaction(async tx => {
    if (values.sku) {
      await tx.execute(catalogLockQuery);
      await assertSkuAvailable(tx, values.sku);
    }
    const [row] = await tx.insert(productsTable).values(values).returning();
    if (row.inventoryType === "Inventory") await tx.insert(inventoryMovementsTable).values({ id: randomUUID(), productId: row.id, kind: "opening", quantity: row.quantityOnHand, reason: "Opening balance recorded when product was created", actorUserId: req.auth!.userId, idempotencyKey: "opening:" + row.id, createdAt: now });
    return row;
  });
  await queueQuickBooksReview("item", product.id, "create", stripNulls(product), ["An approved QuickBooks income account is required"]);
  res.status(201).json(UpdateProductResponse.parse(stripNulls(product)));
}));

router.patch("/products/:id", requireRole("owner", "operations"), domainRoute(async (req, res) => {
  const params = UpdateProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateProductBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  validatePackMetadata(parsed.data);
  const product = await db.transaction(async tx => {
    const sku = parsed.data.sku?.trim();
    if (sku !== undefined) await tx.execute(catalogLockQuery);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"inventory:" + params.data.id}))`);
    const [current] = await tx.select().from(productsTable).where(eq(productsTable.id, params.data.id)).for("update");
    if (!current) throw new DomainError(404, "Product not found");
    assertRevision(current.revision, parsed.data.revision);
    if (parsed.data.imageUrl && parsed.data.imageUrl !== current.imageUrl && !externalImageUrl(parsed.data.imageUrl)) {
      await assertOwnedFile(parsed.data.imageUrl, ["product-image"], req.auth!.userId, "");
    }
    if (sku !== undefined && sku !== current.sku) {
      if (sku && catalogKey(sku) !== catalogKey(current.sku)) await assertSkuAvailable(tx, sku);
      if (current.sku?.trim()) {
        const history = await tx.execute<{ linked: boolean }>(sql`
          SELECT EXISTS (
            SELECT 1 FROM inventory_movements WHERE product_id = ${current.id} AND (kind <> 'opening' OR quantity <> 0)
            UNION ALL SELECT 1 FROM inventory_reservations WHERE product_id = ${current.id}
            UNION ALL SELECT 1 FROM job_materials WHERE product_id = ${current.id}
            UNION ALL SELECT 1 FROM material_usage WHERE product_id = ${current.id}
            UNION ALL SELECT 1 FROM purchase_order_lines WHERE product_id = ${current.id}
            UNION ALL SELECT 1 FROM supplier_product_aliases WHERE product_id = ${current.id}
            UNION ALL SELECT 1 FROM quickbooks_entity_mappings WHERE entity_type = 'item' AND local_id = ${current.id} AND status = 'linked'
          ) AS linked
        `);
        if (current.quantityOnHand !== 0 || history.rows[0]?.linked)
          throw new DomainError(409, "Keep this SKU because stock, purchasing, jobs, or accounting already refer to it. Add a supplier code or archive and replace the product if needed.");
      }
    }
    if (parsed.data.quantityOnHand !== undefined && parsed.data.quantityOnHand !== current.quantityOnHand) throw new DomainError(409, "Record a receipt, return, consumption or adjustment to change stock.");
    if ((parsed.data.unit && parsed.data.unit !== current.unit) || (parsed.data.inventoryType && parsed.data.inventoryType !== current.inventoryType)) {
      const history = await tx.select({ id: inventoryMovementsTable.id }).from(inventoryMovementsTable).where(eq(inventoryMovementsTable.productId, current.id)).limit(1);
      const reserved = await tx.select({ id: inventoryReservationsTable.id }).from(inventoryReservationsTable).where(eq(inventoryReservationsTable.productId, current.id)).limit(1);
      const linked = await tx.select({ id: jobMaterialsTable.id }).from(jobMaterialsTable).where(eq(jobMaterialsTable.productId, current.id)).limit(1);
      if (history.length || reserved.length || linked.length || current.quantityOnHand !== 0) throw new DomainError(409, "This product is linked to stock or job requirements. Create a new product to change its unit or inventory type.");
    }
    const [row] = await tx.update(productsTable).set({ ...parsed.data, sku, quantityOnHand: undefined, revision: current.revision + 1, updatedAt: new Date().toISOString() }).where(eq(productsTable.id, current.id)).returning();
    return row;
  });
  await queueQuickBooksReview("item", product.id, "update", stripNulls(product), ["An approved QuickBooks income account is required"]);

  res.json(UpdateProductResponse.parse(stripNulls(product)));
}));

router.delete("/products/:id", requireRole("owner", "operations"), domainRoute(async (req, res) => {
  const params = DeleteProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"inventory:" + params.data.id}))`);
    const [current] = await tx.select().from(productsTable).where(eq(productsTable.id, params.data.id)).for("update");
    if (!current) throw new DomainError(404, "Product not found");
    const history = await tx.select({ id: inventoryMovementsTable.id }).from(inventoryMovementsTable).where(eq(inventoryMovementsTable.productId, current.id)).limit(1);
    const reservations = await tx.select({ id: inventoryReservationsTable.id }).from(inventoryReservationsTable).where(eq(inventoryReservationsTable.productId, current.id)).limit(1);
    const requirements = await tx.select({ id: jobMaterialsTable.id }).from(jobMaterialsTable).where(eq(jobMaterialsTable.productId, current.id)).limit(1);
    const usage = await tx.select({ id: materialUsageTable.id }).from(materialUsageTable).where(eq(materialUsageTable.productId, current.id)).limit(1);
    if (history.length || reservations.length || requirements.length || usage.length || current.quantityOnHand !== 0) throw new DomainError(409, "Archive this product instead of deleting linked business history.");
    await tx.delete(productsTable).where(eq(productsTable.id, current.id));
  });
  res.status(204).end();
}));

export default router;
