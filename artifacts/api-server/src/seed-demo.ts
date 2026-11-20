import { assertMigrationsApplied, pool } from "@workspace/db";
import { seedDatabase } from "./lib/seed";
import { bootstrapOwner } from "./routes/auth";
import { readFile } from "node:fs/promises";
import { seedKnoxvilleInventory } from "./lib/seed-knoxville-inventory";

async function seedEmptyDemo() {
  if (
    process.env.DEMO_MODE !== "true" ||
    process.env.ALLOW_DEMO_SEED !== "true"
  ) {
    throw new Error(
      "Demo seeding requires DEMO_MODE=true and ALLOW_DEMO_SEED=true on an isolated database.",
    );
  }
  await assertMigrationsApplied(pool);
  // This explicit command cannot refresh or overwrite an existing workspace.
  const client = await pool.connect();
  try {
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(2026112001) AS acquired",
    );
    if (!lock.rows[0]?.acquired)
      throw new Error("Demo seeding is already running for this database.");
    const tables = [
      "jobs",
      "leads",
      "materials",
      "proposals",
      "invoices",
      "products",
      "salespeople",
      "settings",
      "tasks",
      "communications",
      "measurements",
      "customers",
      "crews",
      "crew_bookings",
      "warehouses",
      "inventory_movements",
      "inventory_reservations",
      "inventory_transfers",
      "supplier_product_aliases",
      "supplier_buy_prices",
      "quickbooks_connections",
      "quickbooks_sync_jobs",
      "outlook_calendar_connection",
    ];
    for (const table of tables) {
      const { rows } = await client.query(
        `SELECT EXISTS (SELECT 1 FROM "${table}" LIMIT 1) AS occupied`,
      );
      if (rows[0]?.occupied)
        throw new Error(
          `Refusing demo seeding: ${table} already contains records. Existing data must be preserved.`,
        );
    }
    await seedDatabase();
    await seedKnoxvilleInventory();
    const customerLinks = await readFile(
      new URL(
        "../../../lib/db/migrations/0003_link_existing_customers.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.query("BEGIN");
    try {
      await client.query(
        "UPDATE products SET coverage_per_unit=1, coverage_unit='sqft' WHERE unit='sqft' AND coverage_per_unit IS NULL AND coverage_unit IS NULL",
      );
      for (const statement of customerLinks
        .split("--> statement-breakpoint")
        .map((value) => value.trim())
        .filter(Boolean))
        await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    await bootstrapOwner();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(2026112001)");
    } finally {
      client.release();
    }
  }
  console.log("Initialized the empty, isolated demo workspace.");
}

seedEmptyDemo()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Demo initialization failed",
    );
    process.exitCode = 1;
  })
  .finally(() => pool.end());
