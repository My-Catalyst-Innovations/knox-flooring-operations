import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  db,
  inventoryMovementsTable,
  productsTable,
  proposalsTable,
} from "@workspace/db";
import { roundStock } from "./inventory-stock";

export async function reportMaterialUsage(
  jobs: ReadonlyArray<{ id: string; recordedCompletion: string }>,
) {
  const ids = jobs.map((job) => job.id);
  const baseline = { comparableJobs: 0, unknownJobs: jobs.length, rows: [] };
  if (!ids.length) return baseline;

  const quotes = await db
    .select({
      jobId: proposalsTable.jobId,
      convertedJobId: proposalsTable.convertedJobId,
      acceptedAt: proposalsTable.acceptedAt,
      lines: proposalsTable.lineItems,
    })
    .from(proposalsTable)
    .where(
      and(
        eq(proposalsTable.status, "Accepted"),
        or(
          inArray(proposalsTable.jobId, ids),
          inArray(proposalsTable.convertedJobId, ids),
        ),
      ),
    );
  const completions = new Map(
    jobs.map((job) => [job.id, Date.parse(job.recordedCompletion)]),
  );
  const accepted = new Map<string, typeof quotes>();
  for (const quote of quotes) {
    const id = quote.convertedJobId ?? quote.jobId;
    if (
      !id ||
      !quote.acceptedAt ||
      !(Date.parse(quote.acceptedAt) <= (completions.get(id) ?? NaN))
    )
      continue;
    const forJob = accepted.get(id) ?? [];
    forJob.push(quote);
    accepted.set(id, forJob);
  }
  const approved = [...accepted].flatMap(([id, forJob]) =>
    forJob.length === 1 && Array.isArray(forJob[0].lines)
      ? [{ id, lines: forJob[0].lines }]
      : [],
  );
  const productIds = [
    ...new Set(
      approved.flatMap((job) =>
        job.lines.flatMap((line) => (line?.productId ? [line.productId] : [])),
      ),
    ),
  ];
  if (!productIds.length) return baseline;

  const [products, movements] = await Promise.all([
    db
      .select({
        id: productsTable.id,
        sku: productsTable.sku,
        productName: productsTable.name,
        unit: productsTable.unit,
      })
      .from(productsTable)
      .where(
        and(
          eq(productsTable.inventoryType, "Inventory"),
          inArray(productsTable.id, productIds),
        ),
      ),
    db
      .select({
        jobId: inventoryMovementsTable.jobId,
        productId: inventoryMovementsTable.productId,
        quantity:
          sql<number>`-sum(${inventoryMovementsTable.quantity})`.mapWith(
            Number,
          ),
      })
      .from(inventoryMovementsTable)
      .where(
        and(
          inArray(
            inventoryMovementsTable.jobId,
            approved.map((job) => job.id),
          ),
          inArray(inventoryMovementsTable.productId, productIds),
          inArray(inventoryMovementsTable.kind, ["consume", "return"]),
        ),
      )
      .groupBy(
        inventoryMovementsTable.jobId,
        inventoryMovementsTable.productId,
      ),
  ]);
  const byProduct = new Map(products.map((row) => [row.id, row]));
  const issued = new Map(
    movements.map(({ jobId, productId, quantity }) => [
      JSON.stringify([jobId, productId]),
      quantity,
    ]),
  );
  const totals = new Map<
    string,
    {
      productId: string;
      sku: string;
      productName: string;
      unit: string;
      approvedQuantity: number;
      netIssuedQuantity: number;
    }
  >();
  let comparableJobs = 0;
  for (const job of approved) {
    const matching = new Map<string, number>();
    for (const line of job.lines) {
      const product = line?.productId
        ? byProduct.get(line.productId)
        : undefined;
      if (
        !product ||
        typeof line.unit !== "string" ||
        product.unit.trim().toLowerCase() !== line.unit.trim().toLowerCase() ||
        !Number.isFinite(line.quantity) ||
        line.quantity <= 0
      )
        continue;
      matching.set(product.id, (matching.get(product.id) ?? 0) + line.quantity);
    }
    if (matching.size) comparableJobs += 1;
    for (const [productId, approvedQuantity] of matching) {
      const product = byProduct.get(productId)!;
      const total = totals.get(productId) ?? {
        productId,
        sku: product.sku,
        productName: product.productName,
        unit: product.unit,
        approvedQuantity: 0,
        netIssuedQuantity: 0,
      };
      total.approvedQuantity += approvedQuantity;
      total.netIssuedQuantity +=
        issued.get(JSON.stringify([job.id, productId])) ?? 0;
      totals.set(productId, total);
    }
  }
  const rows = [...totals.values()]
    .sort(
      (a, b) =>
        a.productName.localeCompare(b.productName) ||
        a.sku.localeCompare(b.sku),
    )
    .map((row) => ({
      ...row,
      approvedQuantity: roundStock(row.approvedQuantity),
      netIssuedQuantity: roundStock(row.netIssuedQuantity),
    }));
  return { comparableJobs, unknownJobs: jobs.length - comparableJobs, rows };
}
