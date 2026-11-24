import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { loadMigrations, runMigrations } from "./migration-runner.mjs";
test(
  "outstanding PO provenance migration preserves all previous rows, receipts, stock, financials and ledger",
  { timeout: 30000 },
  async () => {
    const migrations = (await loadMigrations()).filter((m) => m.id < "0030_"),
      prior = migrations.slice(0, -1);
    assert.equal(migrations.at(-1).id, "0029_open_po_outstanding_import");
    assert.equal(prior.at(-1).id, "0028_supplier_contact_import");
    const snapshot = JSON.parse(
      await readFile(
        new URL("../migrations/meta/0029_snapshot.json", import.meta.url),
        "utf8",
      ),
    );
    const actions = {
      "no action": "a",
      restrict: "r",
      cascade: "c",
      "set null": "n",
      "set default": "d",
    };
    const expectedColumns = Object.values(snapshot.tables).flatMap((t) =>
      Object.values(t.columns).map((c) => `${t.name}.${c.name}`),
    );
    const expectedForeignKeys = Object.values(snapshot.tables).flatMap((t) =>
      Object.values(t.foreignKeys).map((f) => ({
        table: t.name,
        name: f.name,
        target: f.tableTo,
        deleteAction: actions[f.onDelete ?? "no action"],
        updateAction: actions[f.onUpdate ?? "no action"],
      })),
    );
    const database = new PGlite();
    try {
      await runMigrations(database, { migrations: prior });
      await database.query(
        "INSERT INTO suppliers(id,name,name_key,created_at,updated_at) VALUES('supplier-old','Existing supplier','existing supplier','2026-11-23','2026-11-23')",
      );
      await database.query(
        "INSERT INTO warehouses(id,name,created_at,updated_at) VALUES('warehouse-old','Office','2026-11-23','2026-11-23')",
      );
      await database.query(
        "INSERT INTO products(id,name,category,sku,unit,cost,price,quantity_on_hand,created_at,updated_at) VALUES('product-old','Existing stock','Tile','000012','sq ft',4.460001,8.120001,2.1,'2026-11-23','2026-11-23')",
      );
      await database.query(
        "INSERT INTO jobs(id,job_number,customer_name,flooring_type,material_status,priority_level,risk_level,status,actual_revenue,actual_labor_cost,share_token,created_at,updated_at) VALUES('job-old','J-0001','Existing customer','Tile','Received','Low','Low','In Progress',430.10,35.04,'retained-token','2026-11-23','2026-11-23')",
      );
      await database.query(
        "INSERT INTO invoices(id,invoice_number,job_id,customer_name,total,paid_amount,balance_amount,status,created_at,updated_at) VALUES('invoice-old','I-0001','job-old','Existing customer',430.10,100.01,330.09,'Partial','2026-11-23','2026-11-23')",
      );
      await database.query(
        "INSERT INTO purchase_orders(id,supplier,warehouse_id,job_id,notes,status,revision,created_by,created_at,updated_at) VALUES('po-old','Existing supplier','warehouse-old','job-old','Keep original note','Partially received',3,'previous-owner','2026-11-23T10:00:00.123456Z','2026-11-23T10:00:00.123456Z')",
      );
      await database.query(
        "INSERT INTO purchase_order_lines(id,order_id,product_id,product_name,sku,unit,position,quantity,unit_cost) VALUES('line-old','po-old','product-old','Existing stock','000012','sq ft',0,12.300001,4.460001)",
      );
      await database.query(
        "INSERT INTO inventory_movements(id,product_id,warehouse_id,quantity,kind,reason,idempotency_key,created_at) VALUES('movement-old','product-old','warehouse-old',2.1,'receipt','Retain receipt','old-movement','2026-11-23T10:00:00.123456Z')",
      );
      await database.query(
        "INSERT INTO purchase_receipts(id,order_id,reference,request_key,request_hash,received_by,received_at) VALUES('receipt-old','po-old','Original receipt','old-receipt',$1,'previous-owner','2026-11-23T10:00:00.123456Z')",
        ["f".repeat(64)],
      );
      await database.query(
        "INSERT INTO purchase_receipt_lines(id,receipt_id,line_id,quantity,movement_id) VALUES('receipt-line-old','receipt-old','line-old',2.1,'movement-old')",
      );
      const tables = (
        await database.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        )
      ).rows.map((r) => r.tablename);
      assert.equal(tables.length, 81);
      const take = async () => {
        const rows = {};
        for (const table of tables.filter(
          (t) => t !== "catalyst_schema_migrations",
        )) {
          assert.match(table, /^[a-z_]+$/);
          rows[table] = (
            await database.query(
              `SELECT to_jsonb(t)::text row FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
            )
          ).rows;
        }
        return rows;
      };
      const before = await take(),
        ledger = (
          await database.query(
            "SELECT to_jsonb(t)::text row FROM catalyst_schema_migrations t ORDER BY id",
          )
        ).rows;
      const result = await runMigrations(database, {
        migrations,
        expectedColumns,
        expectedForeignKeys,
      });
      assert.deepEqual(result.applied, ["0029_open_po_outstanding_import"]);
      assert.deepEqual(await take(), before);
      assert.deepEqual(
        (
          await database.query(
            "SELECT to_jsonb(t)::text row FROM catalyst_schema_migrations t ORDER BY id",
          )
        ).rows.slice(0, 29),
        ledger,
      );
      assert.equal(
        (
          await database.query(
            "SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'",
          )
        ).rows[0].n,
        84,
      );
      for (const table of [
        "open_po_import_batches",
        "open_po_import_approvals",
        "open_po_import_records",
      ])
        assert.equal(
          (await database.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]
            .n,
          0,
        );
      const hash = "a".repeat(64);
      await database.query(
        "INSERT INTO open_po_import_batches(id,workspace_key,source_system,batch_key,file_name,source_sha256,source_csv,delimiter,source_snapshot_at,cutover_at,rows,preview_fingerprint,created_by,created_at,updated_at) VALUES('batch','default','legacy','source-one','source.csv',$1,'original source',',','2026-11-23T14:00:00-05:00','2026-11-23T15:00:00-05:00','[{\"sourcePoId\":\"00001\"}]',$1,'owner','2026-11-23','2026-11-23')",
        [hash],
      );
      await assert.rejects(
        database.query(
          "UPDATE open_po_import_batches SET source_csv='changed' WHERE id='batch'",
        ),
        /immutable/,
      );
      await assert.rejects(
        database.query(
          "UPDATE open_po_import_batches SET cutover_at='2026-11-24' WHERE id='batch'",
        ),
        /immutable/,
      );
      await database.query(
        "INSERT INTO open_po_import_approvals(id,batch_id,fingerprint,preview_fingerprint,reviewed,review_note,approved_by,approved_at) VALUES('approval','batch',$1,$1,'[]','Reviewed outstanding-only source','owner','2026-11-23')",
        [hash],
      );
      await database.query(
        "INSERT INTO open_po_import_records(id,batch_id,approval_id,source_system,source_po_id,source_po_number,order_id,supplier_id,source_data,reviewed_decision,source_record_sha256,action,created_at) VALUES('record','batch','approval','legacy','00001','000078','po-old','supplier-old','{}','{}',$1,'link','2026-11-23')",
        [hash],
      );
      for (const [table, column] of [
        ["open_po_import_approvals", "review_note"],
        ["open_po_import_records", "source_po_number"],
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
        "UPDATE open_po_import_batches SET status='approved',current_approval_id='approval' WHERE id='batch'",
      );
      await database.query(
        "UPDATE open_po_import_batches SET status='committed',committed_at='2026-11-23' WHERE id='batch'",
      );
      await assert.rejects(
        database.query(
          "UPDATE open_po_import_batches SET status='preview',committed_at=NULL WHERE id='batch'",
        ),
        /immutable/,
      );
      await assert.rejects(
        database.query("DELETE FROM open_po_import_batches"),
        /retained/,
      );
      await assert.rejects(
        database.query(
          "INSERT INTO open_po_import_records(id,batch_id,approval_id,source_system,source_po_id,source_po_number,order_id,supplier_id,source_data,reviewed_decision,source_record_sha256,action,created_at) VALUES('duplicate','batch','approval','legacy','other','000079','po-old','supplier-old','{}','{}',$1,'link','2026-11-23')",
          [hash],
        ),
        /unique|duplicate/,
      );
      assert.deepEqual(await take(), before);
      console.log(
        "Open PO0029: all81 prior tables/rows and ledger prefix preserved; only3 empty provenance tables added; source/approvals/links immutable; historical receipts, stock, prices and financial records unchanged.",
      );
    } finally {
      await database.close();
    }
  },
);
