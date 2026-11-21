import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { desc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { supplierDecimalPattern, supplierPurchaseFactor, supplierStockUnitRate } from "@workspace/domain";
import {
  db,
  productsTable,
  supplierBuyPricesTable,
  supplierProductAliasesTable,
} from "@workspace/db";
import { domainRoute, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { requireOwner, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const normalize = (value: string) => value.trim().toLowerCase();
const aliasKey = (supplier: string, sku: string) =>
  JSON.stringify([normalize(supplier), normalize(sku)]);
const normalizedCost = (cost: string) => {
  const [whole, fraction = ""] = cost.split(".");
  return `${(whole || "0").replace(/^0+(?=\d)/, "")}.${fraction.padEnd(6, "0")}`;
};
const requiredText = z.string().trim().min(1).max(200);
const rateInput = z.object({
  productId: requiredText,
  productSku: requiredText,
  supplier: requiredText,
  supplierSku: requiredText,
  manufacturerPartNumber: z.string().trim().max(200).optional(),
  unit: requiredText,
  unitCost: z.string().regex(supplierDecimalPattern),
  stockUnit: requiredText.optional(),
  stockUnitsPerBuyUnit: z.string().trim().regex(supplierDecimalPattern).optional(),
});
const approvalInput = z.object({
  effectiveOn: z.string().date(),
  source: requiredText,
  rows: z.array(rateInput).min(1).max(2500),
});
const priceFilter = z.object({ asOf: z.string().date().optional() });

function publicAlias(alias: typeof supplierProductAliasesTable.$inferSelect) {
  return {
    id: alias.id,
    productId: alias.productId,
    supplier: alias.supplier,
    supplierSku: alias.supplierSku,
    manufacturerPartNumber: alias.manufacturerPartNumber,
  };
}

router.get(
  "/inventory/supplier-crosswalk",
  requireRole("owner", "operations"),
  domainRoute(async (req, res) => {
    const { asOf } = parse(priceFilter, req.query);
    const [aliases, prices] = await Promise.all([
      db.select().from(supplierProductAliasesTable),
      db
        .selectDistinctOn([supplierBuyPricesTable.aliasId], {
          aliasId: supplierBuyPricesTable.aliasId,
          unit: supplierBuyPricesTable.unit,
          stockUnitsPerBuyUnit: supplierBuyPricesTable.stockUnitsPerBuyUnit,
          unitCost: supplierBuyPricesTable.unitCost,
          effectiveOn: supplierBuyPricesTable.effectiveOn,
          source: supplierBuyPricesTable.source,
        })
        .from(supplierBuyPricesTable)
        .where(asOf ? lte(supplierBuyPricesTable.effectiveOn, asOf) : undefined)
        .orderBy(
          supplierBuyPricesTable.aliasId,
          desc(supplierBuyPricesTable.effectiveOn),
        ),
    ]);
    const latest = new Map(prices.map((price) => [price.aliasId, price]));
    res.json(
      aliases.map((alias) => ({
        ...publicAlias(alias),
        latestPrice: latest.get(alias.id) ?? null,
      })),
    );
  }),
);

router.post(
  "/inventory/supplier-crosswalk/approve",
  requireOwner,
  domainRoute(async (req, res) => {
    const { effectiveOn, source, rows } = parse(approvalInput, req.body);
    const rowKeys = rows.map((row) => aliasKey(row.supplier, row.supplierSku));
    if (new Set(rowKeys).size !== rowKeys.length) {
      throw new DomainError(
        400,
        "Each supplier and supplier SKU can appear only once in an approval.",
      );
    }

    const approvedAt = new Date().toISOString();
    const approvedBy = req.auth!.userId;
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('supplier-catalog'))`,
      );

      const productIds = [...new Set(rows.map((row) => row.productId))];
      const products = await tx
        .select({
          id: productsTable.id,
          sku: productsTable.sku,
          unit: productsTable.unit,
          active: productsTable.active,
          inventoryType: productsTable.inventoryType,
        })
        .from(productsTable)
        .where(inArray(productsTable.id, productIds))
        .orderBy(productsTable.id)
        .for("update");
      const productsById = new Map(
        products.map((product) => [product.id, product]),
      );
      const aliases = await tx.select().from(supplierProductAliasesTable);
      const aliasesByKey = new Map(
        aliases.map((alias) => [
          aliasKey(alias.supplier, alias.supplierSku),
          alias,
        ]),
      );
      const previousPrices = await tx
        .select({
          aliasId: supplierBuyPricesTable.aliasId,
          unit: supplierBuyPricesTable.unit,
          unitCost: supplierBuyPricesTable.unitCost,
          stockUnitsPerBuyUnit: supplierBuyPricesTable.stockUnitsPerBuyUnit,
        })
        .from(supplierBuyPricesTable)
        .where(sql`${supplierBuyPricesTable.effectiveOn} = ${effectiveOn}`);
      const pricesByAlias = new Map(
        previousPrices.map((price) => [price.aliasId, price]),
      );
      const newAliases: Array<typeof supplierProductAliasesTable.$inferInsert> =
        [];
      const newPrices: Array<typeof supplierBuyPricesTable.$inferInsert> = [];

      for (const row of rows) {
        const label = `${row.supplier} ${row.supplierSku}`;
        const product = productsById.get(row.productId);
        const sameUnit = product && normalize(product.unit) === normalize(row.unit);
        const factor = product ? supplierPurchaseFactor(row.unit, product.unit, row.stockUnitsPerBuyUnit) : null;
        if (
          !product?.active ||
          normalize(product.sku) !== normalize(row.productSku) ||
          !factor ||
          supplierStockUnitRate(row.unitCost, factor) === null ||
          (row.stockUnit && normalize(product.unit) !== normalize(row.stockUnit)) ||
          (!sameUnit && (!row.stockUnit || product.inventoryType !== "Inventory"))
        ) {
          throw new DomainError(
            409,
            `The catalog mapping or unit for ${label} changed. Preview the CSV again.`,
          );
        }
        const existing = aliasesByKey.get(
          aliasKey(row.supplier, row.supplierSku),
        );
        if (
          existing &&
          (existing.productId !== product.id ||
            (existing.manufacturerPartNumber &&
              row.manufacturerPartNumber &&
              normalize(existing.manufacturerPartNumber) !==
                normalize(row.manufacturerPartNumber)))
        ) {
          throw new DomainError(
            409,
            `${label} already has an approved crosswalk with different product details.`,
          );
        }
        if (
          existing &&
          !existing.manufacturerPartNumber &&
          row.manufacturerPartNumber
        ) {
          await tx
            .update(supplierProductAliasesTable)
            .set({ manufacturerPartNumber: row.manufacturerPartNumber })
            .where(eq(supplierProductAliasesTable.id, existing.id));
        }

        const aliasId = existing?.id ?? randomUUID();
        const previous = pricesByAlias.get(aliasId);
        if (previous) {
          if (
            normalizedCost(previous.unitCost) !==
              normalizedCost(row.unitCost) ||
            normalize(previous.unit) !== normalize(row.unit) ||
            normalizedCost(previous.stockUnitsPerBuyUnit) !== normalizedCost(factor)
          ) {
            throw new DomainError(
              409,
              `${label} already has a different approved cost on ${effectiveOn}.`,
            );
          }
          continue;
        }
        if (!existing) {
          newAliases.push({
            id: aliasId,
            productId: product.id,
            supplier: row.supplier,
            supplierKey: normalize(row.supplier),
            supplierSku: row.supplierSku,
            supplierSkuKey: normalize(row.supplierSku),
            manufacturerPartNumber: row.manufacturerPartNumber || null,
            approvedBy,
            approvedAt,
          });
        }
        newPrices.push({
          id: randomUUID(),
          aliasId,
          unit: sameUnit ? product.unit : row.unit,
          unitCost: row.unitCost,
          stockUnitsPerBuyUnit: factor,
          effectiveOn,
          source,
          approvedBy,
          approvedAt,
        });
      }

      if (newAliases.length)
        await tx.insert(supplierProductAliasesTable).values(newAliases);
      if (newPrices.length)
        await tx.insert(supplierBuyPricesTable).values(newPrices);
      return {
        aliasesAdded: newAliases.length,
        pricesAdded: newPrices.length,
        alreadyApproved: rows.length - newPrices.length,
      };
    });
    res.status(result.pricesAdded ? 201 : 200).json(result);
  }),
);

export default router;
