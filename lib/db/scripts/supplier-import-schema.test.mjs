import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { loadMigrations, runMigrations } from "./migration-runner.mjs";

test(
  "supplier master import migration preserves all existing tables and immutable source identities",
  { timeout: 30000 },
  async () => {
    // Verify exactly 0027 -> 0028, even when a later snapshot is present.
    const snapshot = JSON.parse(
      await readFile(
        new URL("../migrations/meta/0028_snapshot.json", import.meta.url),
        "utf8",
      ),
    );
    const expectedColumns = Object.values(snapshot.tables).flatMap((table) =>
      Object.values(table.columns).map(
        (column) => `${table.name}.${column.name}`,
      ),
    );
    const action = {
      "no action": "a",
      restrict: "r",
      cascade: "c",
      "set null": "n",
      "set default": "d",
    };
    const expectedForeignKeys = Object.values(snapshot.tables).flatMap(
      (table) =>
        Object.values(table.foreignKeys).map((key) => ({
          table: table.name,
          name: key.name,
          target: key.tableTo,
          deleteAction: action[key.onDelete ?? "no action"],
          updateAction: action[key.onUpdate ?? "no action"],
        })),
    );
    const migrations = (await loadMigrations()).filter(
        (migration) => migration.id < "0029_",
      ),
      prior = migrations.filter((m) => m.id < "0028_");
    assert.equal(migrations.at(-1).id, "0028_supplier_contact_import");
    assert.equal(prior.length, 28);
    let database, admin, name;
    if (process.env.TEST_DATABASE_URL) {
      const source = new URL(process.env.TEST_DATABASE_URL);
      assert.ok(["127.0.0.1", "localhost"].includes(source.hostname));
      name = "supplier_schema_" + randomUUID().replaceAll("-", "");
      assert.match(name, /^supplier_schema_[a-f0-9]{32}$/);
      admin = new pg.Client({ connectionString: source.href });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      source.pathname = "/" + name;
      database = new pg.Client({ connectionString: source.href });
      await database.connect();
    } else database = new PGlite();
    try {
      await runMigrations(database, { migrations: prior });
      await database.query(
        "INSERT INTO customers(id,name,created_at,updated_at) VALUES('retained-customer','Original customer','2026-11-23','2026-11-23')",
      );
      await database.query(
        "INSERT INTO jobs(id,job_number,customer_id,customer_name,flooring_type,material_status,priority_level,risk_level,status,actual_revenue,actual_labor_cost,share_token,created_at,updated_at) VALUES('retained-job','RET-1','retained-customer','Original customer','Tile','Received','Low','Low','In Progress',430.10,35.04,'retain-token','2026-11-23','2026-11-23')",
      );
      await database.query(
        "INSERT INTO invoices(id,invoice_number,job_id,customer_id,customer_name,total,paid_amount,balance_amount,status,created_at,updated_at) VALUES('retained-invoice','RET-1','retained-job','retained-customer','Original customer',430.10,100.01,330.09,'Partial','2026-11-23','2026-11-23')",
      );
      const tables = (
        await database.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        )
      ).rows.map((r) => r.tablename);
      assert.equal(tables.length, 77);
      const snap = async () => {
        const data = {};
        for (const table of tables.filter(
          (t) => t !== "catalyst_schema_migrations",
        )) {
          assert.match(table, /^[a-z_]+$/);
          data[table] = (
            await database.query(
              `SELECT to_jsonb(t) row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
            )
          ).rows;
        }
        return data;
      };
      const before = await snap(),
        ledger = (
          await database.query(
            "SELECT * FROM catalyst_schema_migrations ORDER BY id",
          )
        ).rows;
      const result = await runMigrations(database, {
        migrations,
        expectedColumns,
        expectedForeignKeys,
      });
      assert.deepEqual(result.applied, ["0028_supplier_contact_import"]);
      assert.deepEqual(await snap(), before);
      assert.deepEqual(
        (
          await database.query(
            "SELECT * FROM catalyst_schema_migrations ORDER BY id",
          )
        ).rows.slice(0, 28),
        ledger,
      );
      assert.equal(
        (
          await database.query(
            "SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'",
          )
        ).rows[0].n,
        81,
      );
      const hash = "a".repeat(64);
      await assert.rejects(
        database.query(
          "INSERT INTO suppliers(id,name,name_key,created_at,updated_at) VALUES('blank','   ','','2026-11-23','2026-11-23')",
        ),
        /suppliers_name_key_check/,
      );
      await database.query(
        "INSERT INTO suppliers(id,name,name_key,created_at,updated_at) VALUES('supplier','Original Supply','original supply','2026-11-23','2026-11-23')",
      );
      await assert.rejects(
        database.query(
          "INSERT INTO suppliers(id,name,name_key,created_at,updated_at) VALUES('duplicate','ORIGINAL SUPPLY','original supply','2026-11-23','2026-11-23')",
        ),
        /unique|duplicate/,
      );
      await database.query(
        "UPDATE suppliers SET phone='000001',revision=revision+1 WHERE id='supplier'",
      );
      await assert.rejects(
        database.query(
          "UPDATE suppliers SET name='Renamed' WHERE id='supplier'",
        ),
        /Canonical supplier/,
      );
      await assert.rejects(
        database.query("DELETE FROM suppliers WHERE id='supplier'"),
        /deactivate/,
      );
      await database.query(
        "INSERT INTO supplier_import_batches(id,workspace_key,source_system,batch_key,file_name,source_sha256,source_csv,delimiter,rows,preview_fingerprint,created_by,created_at,updated_at) VALUES('batch','fixture','legacy','batch','source.csv',$1,'source_id,name\n0001,Original Supply',',','[{\"line\":2}]',$1,'owner','2026-11-23','2026-11-23')",
        [hash],
      );
      await assert.rejects(
        database.query(
          "UPDATE supplier_import_batches SET source_csv='changed' WHERE id='batch'",
        ),
        /immutable/,
      );
      await database.query(
        "INSERT INTO supplier_import_approvals(id,batch_id,fingerprint,preview_fingerprint,decisions,review_note,approved_by,approved_at) VALUES('approval','batch',$1,$1,'[{\"line\":2,\"action\":\"create\"}]','Reviewed source contacts','owner','2026-11-23')",
        [hash],
      );
      await database.query(
        "UPDATE supplier_import_batches SET status='approved',current_approval_id='approval' WHERE id='batch'",
      );
      const insert =
        "INSERT INTO supplier_import_records(id,batch_id,approval_id,source_system,source_id,source_line,supplier_id,action,source_data,supplier_snapshot,source_row_sha256,created_at) VALUES($1,'batch','approval','legacy','0001',2,'supplier','link','{\"name\":\"Original old supplier name\"}','{\"name\":\"Original Supply\"}',$2,'2026-11-23')";
      await database.query(insert, ["record", hash]);
      await assert.rejects(
        database.query(insert, ["duplicate", hash]),
        /unique|duplicate/,
      );
      for (const [table, column] of [
        ["supplier_import_approvals", "review_note"],
        ["supplier_import_records", "source_id"],
      ]) {
        await assert.rejects(
          database.query(`UPDATE ${table} SET ${column}='changed'`),
          /immutable/,
        );
        await assert.rejects(
          database.query(`DELETE FROM ${table}`),
          /immutable/,
        );
      }
      await database.query(
        "UPDATE supplier_import_batches SET status='committed',committed_at='2026-11-23' WHERE id='batch'",
      );
      await assert.rejects(
        database.query(
          "UPDATE supplier_import_batches SET status='preview',committed_at=null WHERE id='batch'",
        ),
        /immutable/,
      );
      await assert.rejects(
        database.query("DELETE FROM supplier_import_batches"),
        /retained/,
      );
      assert.deepEqual(await snap(), before);
      console.log(
        "Supplier0028 schema checks passed: 77 old tables/rows and ledger prefix preserved; 4 supplier tables added; canonical names retained, contacts editable, deletion blocked, approvals/source bindings immutable.",
      );
    } finally {
      if (admin) {
        await database?.end();
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
        await admin.end();
      } else await database?.close();
    }
  },
);
