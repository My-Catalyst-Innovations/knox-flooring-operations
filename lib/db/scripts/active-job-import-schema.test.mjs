import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { loadMigrations, runMigrations } from "./migration-runner.mjs";
test(
  "active-job0030 preserves all rows/defaults, permits explicit unknown money, and retains import/billing identities",
  { timeout: 60000 },
  async () => {
    const load = async (n) =>
      JSON.parse(
        await readFile(
          new URL(`../migrations/meta/${n}_snapshot.json`, import.meta.url),
          "utf8",
        ),
      );
    const previous = await load("0029"),
      snapshot = await load("0030");
    const money = [
      "labor_estimate",
      "material_estimate",
      "est_revenue",
      "est_gross_profit",
      "gross_margin_pct",
      "actual_revenue",
      "actual_labor_cost",
      "actual_material_cost",
      "actual_add_on_cost",
    ];
    for (const [name, definition] of Object.entries(previous.tables)) {
      const expected = structuredClone(definition);
      if (name === "public.jobs")
        for (const key of money) {
          assert.equal(expected.columns[key].notNull, true);
          expected.columns[key].notNull = false;
        }
      assert.deepEqual(
        snapshot.tables[name],
        expected,
        `Only nine nullable flags may change on old table ${name}`,
      );
    }
    assert.equal(
      Object.keys(snapshot.tables).length - Object.keys(previous.tables).length,
      8,
    );
    const migrations = (await loadMigrations()).filter(
        (row) => row.id < "0031_",
      ),
      prior = migrations.filter((row) => row.id < "0030_");
    assert.equal(prior.at(-1).id, "0029_open_po_outstanding_import");
    assert.equal(migrations.at(-1).id, "0030_active_job_cutover_import");
    const database = new PGlite();
    try {
      await runMigrations(database, { migrations: prior });
      await database.query(
        "INSERT INTO customers(id,name,created_at,updated_at) VALUES('retained-customer','Original customer','2026-11-23','2026-11-23')",
      );
      const insertJob =
        "INSERT INTO jobs(id,job_number,customer_id,customer_name,flooring_type,material_status,priority_level,risk_level,status,actual_revenue,actual_labor_cost,share_token,created_at,updated_at) VALUES($1,$1,'retained-customer','Original customer','Tile','Received','Low','Low','Approved',430.10,35.04,'retain-token','2026-11-23','2026-11-23')";
      await database.query(insertJob, ["retained-job"]);
      await database.query(
        "INSERT INTO invoices(id,invoice_number,job_id,customer_id,customer_name,total,paid_amount,balance_amount,status,created_at,updated_at) VALUES('retained-invoice','RET-1','retained-job','retained-customer','Original customer',430.10,100.01,330.09,'Partial','2026-11-23','2026-11-23')",
      );
      const tables = (
        await database.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        )
      ).rows.map((row) => row.tablename);
      assert.equal(tables.length, 84);
      const capture = async () => {
        const value = {};
        for (const table of tables.filter(
          (table) => table !== "catalyst_schema_migrations",
        ))
          value[table] = (
            await database.query(
              `SELECT to_jsonb(t) row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
            )
          ).rows;
        return value;
      };
      const before = await capture(),
        ledger = (
          await database.query(
            "SELECT * FROM catalyst_schema_migrations ORDER BY id",
          )
        ).rows;
      const applied = await runMigrations(database, { migrations });
      assert.deepEqual(applied.applied, ["0030_active_job_cutover_import"]);
      assert.deepEqual(await capture(), before);
      assert.deepEqual(
        (
          await database.query(
            "SELECT * FROM catalyst_schema_migrations ORDER BY id",
          )
        ).rows.slice(0, 30),
        ledger,
      );
      assert.equal(
        (
          await database.query(
            "SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'",
          )
        ).rows[0].n,
        92,
      );
      for (const key of money) {
        const row = (
          await database.query(
            "SELECT is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='jobs' AND column_name=$1",
            [key],
          )
        ).rows[0];
        assert.equal(row.is_nullable, "YES");
        assert.match(row.column_default, /0/);
      }
      await database.query(insertJob, ["imported-job"]);
      await database.query(
        `UPDATE jobs SET ${money.map((key) => `"${key}"=NULL`).join(",")},share_token='' WHERE id='imported-job'`,
      );
      const h = "a".repeat(64);
      await database.query(
        "INSERT INTO active_job_import_batches(id,workspace_key,source_system,batch_key,file_name,source_sha256,source_csv,delimiter,rows,preview_fingerprint,created_by,created_at,updated_at) VALUES('batch','fixture','legacy','batch','original.csv',$1,'source_id,source_status\n0001,Approved',',','[{\"line\":2}]',$1,'owner','2026-11-23','2026-11-23')",
        [h],
      );
      await database.query(
        "INSERT INTO active_job_import_approvals(id,batch_id,fingerprint,preview_fingerprint,decisions,review_note,approved_by,approved_at) VALUES('approval','batch',$1,$1,'[]','Reviewed source','owner','2026-11-23')",
        [h],
      );
      await database.query(
        "INSERT INTO active_job_import_records(id,batch_id,approval_id,source_system,source_id,source_line,job_id,customer_id,action,source_data,decision,source_row_sha256,created_at) VALUES('record','batch','approval','legacy','0001',2,'imported-job','retained-customer','create','{}','{}',$1,'2026-11-23')",
        [h],
      );
      await database.query(
        "INSERT INTO job_cutovers(job_id,source_record_id,created_at,updated_at) VALUES('imported-job','record','2026-11-23','2026-11-23')",
      );
      await assert.rejects(
        database.query(
          "UPDATE active_job_import_records SET source_id='different'",
        ),
        /immutable/,
      );
      await assert.rejects(
        database.query(
          "UPDATE active_job_import_batches SET source_csv='different'",
        ),
        /immutable/,
      );
      await assert.rejects(
        database.query("DELETE FROM job_cutovers"),
        /retained/,
      );
      await database.query(
        "INSERT INTO job_cutover_reviews(id,job_id,kind,job_revision,cutover_revision,scope_fingerprint,source_fingerprint,payload,fingerprint,reviewed_by,reviewed_at) VALUES('review','imported-job','billing',1,1,$1,$1,'{}',$1,'owner','2026-11-23')",
        [h],
      );
      await database.query(
        "INSERT INTO job_cutover_approvals(id,review_id,job_id,kind,fingerprint,approved_by,approved_at) VALUES('cutover-approval','review','imported-job','billing',$1,'owner','2026-11-23')",
        [h],
      );
      await database.query(
        "INSERT INTO job_cutover_commits(id,approval_id,job_id,kind,fingerprint,result,committed_by,committed_at) VALUES('commit','cutover-approval','imported-job','billing',$1,'{}','owner','2026-11-23')",
        [h],
      );
      await database.query(
        "UPDATE job_cutovers SET billing_commit_id='commit',revision=2 WHERE job_id='imported-job'",
      );
      await database.query(
        "INSERT INTO invoices(id,invoice_number,job_id,customer_id,customer_name,total,status,created_at,updated_at) VALUES('new-invoice','NEW-1','imported-job','retained-customer','Original customer',25,'Draft','2026-11-23','2026-11-23')",
      );
      await database.query(
        "INSERT INTO job_cutover_invoice_requests(id,job_id,invoice_id,billing_commit_id,request_fingerprint,request_payload,initial_gross_cents,current_gross_cents,financial_fingerprint,created_by,created_at,updated_at) VALUES('request','imported-job','new-invoice','commit',$1,'{}',2500,2500,$1,'owner','2026-11-23','2026-11-23')",
        [h],
      );
      await assert.rejects(
        database.query("DELETE FROM invoices WHERE id='new-invoice'"),
        /retained/,
      );
      await assert.rejects(
        database.query(
          "UPDATE invoices SET job_id='retained-job' WHERE id='new-invoice'",
        ),
        /attribution/,
      );
      await assert.rejects(
        database.query(
          "UPDATE invoices SET customer_id=null WHERE id='new-invoice'",
        ),
        /attribution/,
      );
      await database.query(
        "UPDATE invoices SET status='Voided',refunded_amount=25 WHERE id='new-invoice'",
      );
      assert.equal(
        Number(
          (
            await database.query(
              "SELECT current_gross_cents FROM job_cutover_invoice_requests",
            )
          ).rows[0].current_gross_cents,
        ),
        2500,
      );
      await database.query(
        "UPDATE job_cutover_invoice_requests SET submission_locked=true",
      );
      await assert.rejects(
        database.query(
          "UPDATE job_cutover_invoice_requests SET current_gross_cents=0",
        ),
        /Submitted/,
      );
      await assert.rejects(
        database.query("UPDATE invoices SET total=0 WHERE id='new-invoice'"),
        /Submitted/,
      );
      await assert.rejects(
        database.query(
          "UPDATE invoices SET notes='Changed provider document' WHERE id='new-invoice'",
        ),
        /Submitted/,
      );
      for (const table of [
        "job_cutover_reviews",
        "job_cutover_approvals",
        "job_cutover_commits",
      ])
        await assert.rejects(
          database.query(`DELETE FROM ${table}`),
          /immutable/,
        );
      assert.deepEqual(
        (
          await database.query(
            "SELECT to_jsonb(j) row FROM jobs j WHERE id='retained-job'",
          )
        ).rows,
        before.jobs,
      );
      console.log(
        "Active-job0030:84 prior tables/rows and ledger preserved;9nullable money fields retain native defaults;8new provenance/review/consumption tables;immutable attribution and submitted claims verified.",
      );
    } finally {
      await database.close();
    }
  },
);
