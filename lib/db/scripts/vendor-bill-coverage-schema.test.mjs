import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { loadMigrations, runMigrations } from "./migration-runner.mjs";
test(
  "0031 preserves every prior schema definition/row and rejects nullable company evidence",
  { timeout: 60000 },
  async () => {
    const snapshot = async (id) =>
      JSON.parse(
        await readFile(
          new URL(`../migrations/meta/${id}_snapshot.json`, import.meta.url),
          "utf8",
        ),
      );
    const before = await snapshot("0030"),
      after = await snapshot("0031");
    for (const [name, table] of Object.entries(before.tables))
      assert.deepEqual(after.tables[name], table, name);
    assert.equal(
      Object.keys(after.tables).length - Object.keys(before.tables).length,
      7,
    );
    for (const table of Object.values(after.tables))
      for (const fk of Object.values(table.foreignKeys))
        assert.ok(fk.name.length <= 63, fk.name);
    const pg = new PGlite();
    try {
      const migrations = (await loadMigrations()).filter(
        (row) => row.id < "0032_",
      );
      await runMigrations(pg, {
        migrations: migrations.filter((row) => row.id < "0031_"),
      });
      await pg.query(
        "INSERT INTO customers(id,name,created_at,updated_at) VALUES('retained','Fictional retained','2026-11-23','2026-11-23')",
      );
      const tables = (
        await pg.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'catalyst_schema_migrations' ORDER BY tablename",
        )
      ).rows.map((row) => row.tablename);
      const capture = async () =>
        Object.fromEntries(
          await Promise.all(
            tables.map(async (name) => [
              name,
              (
                await pg.query(
                  `SELECT to_jsonb(t) row FROM "${name}" t ORDER BY to_jsonb(t)::text`,
                )
              ).rows,
            ]),
          ),
        );
      const rows = await capture(),
        ledger = (
          await pg.query("SELECT * FROM catalyst_schema_migrations ORDER BY id")
        ).rows;
      assert.deepEqual((await runMigrations(pg, { migrations })).applied, [
        "0031_vendor_bill_receipt_allocations",
      ]);
      assert.deepEqual(await capture(), rows);
      assert.deepEqual(
        (
          await pg.query("SELECT * FROM catalyst_schema_migrations ORDER BY id")
        ).rows.slice(0, ledger.length),
        ledger,
      );
      const approval =
        "INSERT INTO vendor_bill_coverage_approvals(id,request_key,request_fingerprint,fingerprint,mode,workspace_key,connection_id,realm_id,environment,choice,source_snapshot,note,created_by,created_at) VALUES($1,$1,$2,$2,$3,'fixture',$4,$5,$6,'{}','{}','Fictional owner review','owner','2026-11-23')";
      const hash = "a".repeat(64);
      for (const company of [
        ["conn", null, "sandbox"],
        ["conn", "123", null],
        [null, "123", "sandbox"],
      ])
        await assert.rejects(
          pg.query(approval, [
            "bad-" + String(company),
            hash,
            "quickbooks_verified",
            ...company,
          ]),
          /check constraint/,
        );
      await pg.query(approval, [
        "local",
        hash,
        "local_review",
        null,
        null,
        null,
      ]);
      await assert.rejects(
        pg.query(
          "UPDATE vendor_bill_coverage_approvals SET note='Replacement source note' WHERE id='local'",
        ),
        /immutable/,
      );
      await assert.rejects(
        pg.query("DELETE FROM vendor_bill_coverage_approvals WHERE id='local'"),
        /immutable/,
      );
      console.log(
        JSON.stringify({
          coverageSchema: "passed",
          priorTables: tables.length,
          newTables: 7,
          originalRowsPreserved: true,
        }),
      );
    } finally {
      await pg.close();
    }
  },
);
