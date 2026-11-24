import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { loadMigrations, runMigrations } from "./migration-runner.mjs";

test(
  "legacy archive migration only adds immutable historical storage and preserves every old table",
  { timeout: 30000 },
  async () => {
    const migrations = (await loadMigrations()).filter(
        (migration) => migration.id < "0027_",
      ),
      prior = migrations.filter((m) => m.id < "0026_");
    assert.equal(migrations.at(-1).id, "0026_legacy_history_archive");
    assert.equal(prior.length, 26);
    // This test deliberately rehearses ONLY0026, even when future migrations
    // exist. Its expected shape must come from that same immutable snapshot.
    const schema = JSON.parse(
      await readFile(
        new URL("../migrations/meta/0026_snapshot.json", import.meta.url),
        "utf8",
      ),
    );
    const expectedColumns = Object.values(schema.tables).flatMap((table) =>
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
    const expectedForeignKeys = Object.values(schema.tables).flatMap((table) =>
      Object.values(table.foreignKeys).map((key) => ({
        table: table.name,
        name: key.name,
        target: key.tableTo,
        deleteAction: action[key.onDelete ?? "no action"],
        updateAction: action[key.onUpdate ?? "no action"],
      })),
    );
    let database, admin, name;
    if (process.env.TEST_DATABASE_URL) {
      const source = new URL(process.env.TEST_DATABASE_URL);
      assert.ok(["127.0.0.1", "localhost"].includes(source.hostname));
      name = "legacy_schema_" + randomUUID().replaceAll("-", "");
      assert.match(name, /^legacy_schema_[a-f0-9]{32}$/);
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
      assert.equal(tables.length, 71);
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
      assert.deepEqual(result.applied, ["0026_legacy_history_archive"]);
      assert.deepEqual(await snap(), before);
      assert.deepEqual(
        (
          await database.query(
            "SELECT * FROM catalyst_schema_migrations ORDER BY id",
          )
        ).rows.slice(0, 26),
        ledger,
      );
      assert.equal(
        (
          await database.query(
            "SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'",
          )
        ).rows[0].n,
        75,
      );
      const hash = "a".repeat(64),
        rows = JSON.stringify([{ line: 2, data: { sourceId: "0001" } }]);
      await database.query(
        "INSERT INTO legacy_archive_batches(id,workspace_key,source_system,batch_key,file_name,source_sha256,source_csv,delimiter,rows,preview_fingerprint,created_by,created_at,updated_at) VALUES('batch','fixture','legacy','batch','source.csv',$1,'source_id,type,title\n0001,invoice,Original',',',$2,$1,'owner','2026-11-23','2026-11-23')",
        [hash, rows],
      );
      await assert.rejects(
        database.query(
          "UPDATE legacy_archive_batches SET source_csv='changed' WHERE id='batch'",
        ),
        /immutable/,
      );
      await database.query(
        "INSERT INTO legacy_archive_approvals(id,batch_id,fingerprint,preview_fingerprint,decisions,review_note,approved_by,approved_at) VALUES('approval','batch',$1,$1,'[{\"line\":2,\"action\":\"archive\"}]','Reviewed original historical source','owner','2026-11-23')",
        [hash],
      );
      await database.query(
        "UPDATE legacy_archive_batches SET status='approved',current_approval_id='approval' WHERE id='batch'",
      );
      await database.query(
        "INSERT INTO legacy_archive_records(id,batch_id,approval_id,source_system,source_id,source_line,record_type,title,record_sha256,created_at) VALUES('record','batch','approval','legacy','0001',2,'invoice','Original source invoice',$1,'2026-11-23')",
        [hash],
      );
      await database.query(
        "INSERT INTO legacy_archive_documents(id,record_id,object_path,name,size,sha256,actor_user_id,request_key,created_at) VALUES('document','record','/objects/files/legacy-document/00000000-0000-4000-8000-000000000001','original.pdf',20,$1,'owner','request','2026-11-23')",
        [hash],
      );
      for (const [table, column] of [
        ["legacy_archive_approvals", "review_note"],
        ["legacy_archive_records", "title"],
        ["legacy_archive_documents", "name"],
      ]) {
        await assert.rejects(
          database.query(`UPDATE ${table} SET ${column}='tampered'`),
          /immutable/,
        );
        await assert.rejects(
          database.query(`DELETE FROM ${table}`),
          /immutable/,
        );
      }
      await database.query(
        "UPDATE legacy_archive_batches SET status='committed',committed_at='2026-11-23' WHERE id='batch'",
      );
      await assert.rejects(
        database.query(
          "UPDATE legacy_archive_batches SET status='preview',committed_at=null WHERE id='batch'",
        ),
        /immutable/,
      );
      await assert.rejects(
        database.query("DELETE FROM legacy_archive_batches"),
        /retained/,
      );
      await assert.rejects(
        database.query(
          "INSERT INTO legacy_archive_records(id,batch_id,approval_id,source_system,source_id,source_line,record_type,title,record_sha256,created_at) VALUES('duplicate','batch','approval','legacy','0001',2,'invoice','Duplicate',$1,'2026-11-23')",
          [hash],
        ),
        /unique|duplicate/,
      );
      assert.deepEqual(await snap(), before);
      console.log(
        "Archive0026 schema checks passed: 71 old tables/rows and ledger prefix preserved; 4 private archive tables added; source content, approvals, records and accepted document claims immutable; no active records/providers changed.",
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
