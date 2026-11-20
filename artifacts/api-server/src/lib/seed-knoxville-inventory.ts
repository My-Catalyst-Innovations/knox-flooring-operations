import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  crewsTable,
  db,
  inventoryMovementsTable,
  inventoryReservationsTable,
  inventoryTransfersTable,
  invoicesTable,
  jobMaterialsTable,
  jobsTable,
  materialsTable,
  productsTable,
  proposalsTable,
  supplierBuyPricesTable,
  supplierProductAliasesTable,
  warehousesTable,
} from "@workspace/db";

const officeId = "demo-knox-office";
const remoteId = "demo-knox-remote";
const slateId = "demo-knox-slate";
const transferId = "demo-knox-transfer";
const jobId = "demo-knox-install";
const invoiceId = "demo-knox-invoice";
const aliasId = "demo-knox-slate-alias";
const seededBy = "demo-fixture";
const supplier = "Demo Flooring Supply";
const productName = "Demo Slate Luxury Vinyl Tile";

export async function seedKnoxvilleInventory() {
  const now = new Date();
  const dates = { createdAt: now.toISOString(), updatedAt: now.toISOString() };
  const businessDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const scheduledDay = new Date(`${businessDay}T12:00:00.000Z`);
  do scheduledDay.setUTCDate(scheduledDay.getUTCDate() + 1);
  while ([0, 6].includes(scheduledDay.getUTCDay()));

  await db.transaction(async (tx) => {
    await tx.insert(warehousesTable).values([
      { id: officeId, name: "Office warehouse", ...dates },
      { id: remoteId, name: "Remote warehouse", ...dates },
    ]);
    await tx.insert(crewsTable).values({
      id: "demo-knox-crew",
      name: "Demo Installation Crew",
      timezone: "America/New_York",
      size: 2,
      dailyCapacityHours: 8,
      workingDays: [1, 2, 3, 4, 5],
      ...dates,
    });
    await tx.insert(productsTable).values({
      id: slateId,
      name: productName,
      category: "Vinyl Tile",
      sku: "KNOX-SLATE-48",
      supplier,
      color: "Slate Gray",
      unit: "box",
      cost: 48,
      price: 75,
      quantityOnHand: 44,
      inventoryType: "Inventory",
      coveragePerUnit: 20,
      coverageUnit: "sqft",
      reorderPoint: 10,
      notes:
        "Fictional demonstration SKU with stock at both warehouses and one transfer in transit.",
      ...dates,
    });
    await tx.insert(jobsTable).values({
      id: jobId,
      jobNumber: "J-KNX-DEMO",
      customerName: "Sample Knoxville Kitchen",
      address: "100 Sample Avenue",
      city: "Knoxville",
      email: "kitchen@example.test",
      flooringType: "Tile",
      squareFootage: 160,
      materialStatus: "Received",
      priorityLevel: "Medium",
      riskLevel: "Low",
      status: "Material Received",
      estStartDate: scheduledDay.toISOString().slice(0, 10),
      estRevenue: 1200,
      laborEstimate: 300,
      materialEstimate: 384,
      stageHistory: [{ stage: "Material Received", at: dates.createdAt }],
      notes:
        "Fictional demo job ready to book. Eight boxes are reserved at the office warehouse.",
      shareToken: randomBytes(12).toString("hex"),
      ...dates,
    });
    await tx.insert(proposalsTable).values({
      id: "demo-knox-proposal",
      jobId,
      convertedJobId: jobId,
      convertedInvoiceId: invoiceId,
      customerName: "Sample Knoxville Kitchen",
      projectLocation: "100 Sample Avenue, Knoxville",
      flooringType: "Tile",
      totalSqFt: 160,
      scopeOfWork: "Prepare the kitchen and install slate-look vinyl tile.",
      lineItems: [
        {
          id: "demo-knox-quote-material",
          productId: slateId,
          name: productName,
          sku: "KNOX-SLATE-48",
          unit: "box",
          quantity: 8,
          unitPrice: 75,
          lineTotal: 600,
        },
        {
          id: "demo-knox-quote-labor",
          name: "Installation labor",
          unit: "job",
          quantity: 1,
          unitPrice: 600,
          lineTotal: 600,
        },
      ],
      estimatedPrice: 1200,
      status: "Accepted",
      acceptedAt: dates.createdAt,
      signature: "Sample customer",
      shareToken: randomBytes(12).toString("hex"),
      createdAt: dates.createdAt,
    });
    await tx.insert(invoicesTable).values({
      id: invoiceId,
      jobId,
      jobNumber: "J-KNX-DEMO",
      invoiceNumber: "INV-KNX-DEMO",
      customerName: "Sample Knoxville Kitchen",
      lineItems: [
        {
          id: "demo-knox-billing-material",
          description: productName,
          category: "Materials",
          quantity: 8,
          unitPrice: 75,
        },
        {
          id: "demo-knox-billing-labor",
          description: "Installation labor",
          category: "Labor",
          quantity: 1,
          unitPrice: 600,
        },
      ],
      subtotal: 1200,
      total: 1200,
      balanceAmount: 1200,
      status: "Draft",
      ...dates,
    });
    await tx.insert(jobMaterialsTable).values({
      id: "demo-knox-job-material",
      jobId,
      productId: slateId,
      name: productName,
      quantity: 8,
      unit: "box",
      createdAt: dates.createdAt,
    });
    await tx.insert(materialsTable).values({
      id: "demo-knox-material-receipt",
      jobId,
      jobNumber: "J-KNX-DEMO",
      customer: "Sample Knoxville Kitchen",
      city: "Knoxville",
      flooringType: "Tile",
      supplier,
      actualDeliveryDate: businessDay,
      received: true,
      status: "Received",
      notes: "Eight boxes are reserved at the office warehouse.",
    });
    await tx.insert(inventoryTransfersTable).values({
      id: transferId,
      productId: slateId,
      sourceWarehouseId: remoteId,
      destinationWarehouseId: officeId,
      quantity: 6,
      reason: "Restock the office warehouse",
      status: "In transit",
      idempotencyKey: transferId,
      dispatchedBy: seededBy,
      ...dates,
    });
    await tx.insert(inventoryMovementsTable).values([
      {
        id: "demo-knox-opening-office",
        productId: slateId,
        warehouseId: officeId,
        quantity: 20,
        kind: "opening",
        reason: "Office opening count",
        idempotencyKey: "demo-knox-opening-office",
        createdAt: dates.createdAt,
      },
      {
        id: "demo-knox-opening-remote",
        productId: slateId,
        warehouseId: remoteId,
        quantity: 30,
        kind: "opening",
        reason: "Remote opening count",
        idempotencyKey: "demo-knox-opening-remote",
        createdAt: dates.createdAt,
      },
      {
        id: "demo-knox-transfer-out",
        productId: slateId,
        warehouseId: remoteId,
        transferId,
        quantity: -6,
        kind: "transfer_out",
        reason: "Restock the office warehouse",
        idempotencyKey: `${transferId}:out`,
        createdAt: dates.createdAt,
      },
    ]);
    await tx.insert(inventoryReservationsTable).values({
      id: "demo-knox-office-reservation",
      productId: slateId,
      jobId,
      warehouseId: officeId,
      quantity: 8,
      status: "Active",
      idempotencyKey: "demo-knox-office-reservation",
      ...dates,
    });
    await tx.insert(supplierProductAliasesTable).values({
      id: aliasId,
      productId: slateId,
      supplier,
      supplierKey: supplier.toLowerCase(),
      supplierSku: "00048-SLATE",
      supplierSkuKey: "00048-slate",
      manufacturerPartNumber: "DEMO-MFR-4820",
      approvedBy: seededBy,
      approvedAt: dates.createdAt,
    });
    await tx.insert(supplierBuyPricesTable).values({
      id: "demo-knox-slate-rate",
      aliasId,
      unit: "box",
      unitCost: "48.000000",
      effectiveOn: businessDay,
      source: "Fictional demo vendor price sheet",
      approvedBy: seededBy,
      approvedAt: dates.createdAt,
    });

    // Seeded products arrive after the opening-ledger migration. Keep other
    // products in Unassigned and leave counts already recorded above intact.
    await tx.execute(sql`
      INSERT INTO inventory_movements (id, product_id, quantity, kind, reason, idempotency_key, created_at)
      SELECT 'opening:' || p.id, p.id, p.quantity_on_hand, 'opening', 'Opening balance of explicit demo fixture', 'opening:' || p.id, ${dates.createdAt}
      FROM products p WHERE NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.product_id = p.id)
      ON CONFLICT (idempotency_key) DO NOTHING`);
  });
}
