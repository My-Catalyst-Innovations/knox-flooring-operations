/** Disposable loopback databases only. Actual tenant/auth/routes; no provider I/O. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { db, pool, usersTable, closeWorkspaceConnections } from "@workspace/db";
import { inWorkspace, workspaceConfigs } from "@workspace/db/workspace";
import {
  openPoImportColumns,
  type OpenPoDecision,
  type OpenPoImportBatch,
} from "@workspace/domain";
import { hashPassword } from "../src/lib/auth";
import app from "../src/app";
assert.equal(process.env.CATALYST_ISOLATED_TEST, "true");
assert.equal(workspaceConfigs.length, 2);
for (const workspace of workspaceConfigs) {
  const url = new URL(workspace.databaseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.pathname, /^\/open_po_import_[a-f0-9]{32}_[ab]$/);
}
const context = (index: number, work: () => Promise<any>) =>
  inWorkspace(workspaceConfigs[index], work);
const checks: string[] = [];
let providerCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  providerCalls++;
  throw new Error("Provider I/O is forbidden in PO migration fixtures.");
};
const password = "Fictional-PO-import-fixture-password";
type Actor = { host: string; cookie: string; csrf: string };
async function call(
  actor: Actor,
  method: string,
  path: string,
  input?: unknown,
  status = 200,
) {
  let req = (request(app) as any)
    [method.toLowerCase()]("/api" + path)
    .set("Host", actor.host)
    .set("Origin", "https://" + actor.host)
    .set("Cookie", actor.cookie);
  if (method !== "GET") req = req.set("x-csrf-token", actor.csrf);
  if (input !== undefined) req = req.send(input);
  const response = await req;
  assert.equal(
    response.status,
    status,
    JSON.stringify({ path, status: response.status, body: response.body }),
  );
  return response.body;
}
async function login(index: number, role: string): Promise<Actor> {
  const host = `${index ? "b" : "a"}.import.test`;
  const response = await request(app)
    .post("/api/auth/login")
    .set("Host", host)
    .set("Origin", "https://" + host)
    .send({ email: `${role}@fictional.example.invalid`, password });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return {
    host,
    csrf: response.body.csrfToken,
    cookie: response.headers["set-cookie"][0].split(";")[0],
  };
}
const sourceLine = (
  id: string,
  change: Partial<Record<(typeof openPoImportColumns)[number], string>> = {},
) => ({
  source_po_id: id,
  source_po_number: "000078",
  source_line_id: "000001",
  source_status: "Partially received",
  supplier_ref: "Source supplier001",
  warehouse_ref: "Source office001",
  job_ref: "",
  product_ref: "000012",
  unit: "box",
  ordered_qty: "12.300001",
  received_qty: "2.1",
  cancelled_qty: "0.2",
  outstanding_qty: "10.000001",
  unit_cost: "4.460001",
  currency: "USD",
  expected_on: "2026-12-01",
  ...change,
});
function input(id: string, rows = [sourceLine(id)]) {
  const quote = (value: string) =>
    /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  return {
    sourceSystem: "fictional-legacy",
    batchKey: "batch-" + id,
    fileName: "Original outstanding orders.csv",
    sourceSnapshotAt: "2026-11-23T14:00:00-05:00",
    cutoverAt: "2026-11-23T15:00:00-05:00",
    delimiter: ",",
    csv:
      "\uFEFF" +
      openPoImportColumns.join(",") +
      "\r\n" +
      rows
        .map((row) =>
          openPoImportColumns.map((column) => quote(row[column])).join(","),
        )
        .join("\r\n") +
      "\r\n",
  };
}
const path = (batch: OpenPoImportBatch, action: string) =>
  `/open-po-imports/${batch.id}/${action}`;
async function preview(
  actor: Actor,
  id: string,
  rows?: ReturnType<typeof sourceLine>[],
) {
  const before = await context(0, purchasingSnapshot);
  const result = (await call(
    actor,
    "POST",
    "/open-po-imports/preview",
    input(id, rows),
    201,
  )) as OpenPoImportBatch;
  assert.deepEqual(
    await context(0, purchasingSnapshot),
    before,
    "Preview must not create or edit any PO or line.",
  );
  return result;
}
async function options(actor: Actor, kind: string) {
  return (await call(actor, "GET", `/open-po-imports/options?kind=${kind}`))
    .items;
}
async function choice(
  actor: Actor,
  batch: OpenPoImportBatch,
  change: Partial<OpenPoDecision> = {},
): Promise<OpenPoDecision> {
  const supplier = (await options(actor, "supplier")).find(
      (item: any) => item.id === "fixture-supplier",
    ),
    warehouse = (await options(actor, "warehouse")).find(
      (item: any) => item.id === "fixture-warehouse",
    ),
    product = (await options(actor, "product")).find(
      (item: any) => item.id === "fixture-product",
    );
  assert.ok(supplier && warehouse && product);
  return {
    sourcePoId: batch.rows[0].sourcePoId,
    action: "create",
    note: "Owner verified exact remaining source quantities at cutover",
    supplierId: supplier.id,
    supplierRevision: supplier.revision,
    warehouseId: warehouse.id,
    warehouseUpdatedAt: warehouse.updatedAt,
    jobId: null,
    sourceOpenConfirmed: true,
    outstandingOnlyConfirmed: true,
    lines: batch.rows[0].lines.map((row) => ({
      line: row.line,
      action: "include",
      productId: product.id,
      productRevision: product.revision,
      note: "",
    })),
    ...change,
  };
}
async function review(
  actor: Actor,
  batch: OpenPoImportBatch,
  decisions: OpenPoDecision[],
  status = 200,
) {
  const before = await context(0, purchasingSnapshot);
  const result = (await call(
    actor,
    "POST",
    path(batch, "review"),
    {
      revision: batch.revision,
      previewFingerprint: batch.previewFingerprint,
      note: "Owner reviewed exact local records and source evidence",
      decisions,
    },
    status,
  )) as OpenPoImportBatch;
  assert.deepEqual(
    await context(0, purchasingSnapshot),
    before,
    "Successful or rejected review must not create or edit any PO or line.",
  );
  return result;
}
async function approve(actor: Actor, batch: OpenPoImportBatch) {
  const before = await context(0, purchasingSnapshot);
  const result = (await call(actor, "POST", path(batch, "approve"), {
    revision: batch.revision,
    reviewFingerprint: batch.reviewFingerprint,
    confirmOutstandingOnly: true,
  })) as OpenPoImportBatch;
  assert.deepEqual(
    await context(0, purchasingSnapshot),
    before,
    "Approval alone must not create or edit any PO or line.",
  );
  return result;
}
async function authorize(
  actor: Actor,
  batch: OpenPoImportBatch,
  decision?: OpenPoDecision,
) {
  return approve(
    actor,
    await review(actor, batch, [decision ?? (await choice(actor, batch))]),
  );
}
const commitBody = (batch: OpenPoImportBatch) => ({
  revision: batch.revision,
  approvalId: batch.approval!.id,
  approvalFingerprint: batch.approval!.fingerprint,
  confirmOutstandingOnly: true,
});
async function protectedSnapshot() {
  const tables = (
    await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows
    .map((row) => row.tablename as string)
    .filter(
      (name) =>
        !name.startsWith("open_po_import_") &&
        ![
          "audit_events",
          "sessions",
          "users",
          "purchase_orders",
          "purchase_order_lines",
        ].includes(name),
    );
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    assert.match(table, /^[a-z_]+$/);
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t)::text row FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows;
  }
  return result;
}
async function purchasingSnapshot() {
  return {
    headers: (
      await pool.query(
        "SELECT id,to_jsonb(t)::text row FROM purchase_orders t ORDER BY id",
      )
    ).rows,
    lines: (
      await pool.query(
        'SELECT id,order_id AS "orderId",to_jsonb(t)::text row FROM purchase_order_lines t ORDER BY id',
      )
    ).rows,
  };
}
async function normalized(value: string) {
  return (await pool.query("SELECT $1::numeric(18,6)::text value", [value]))
    .rows[0].value as string;
}
async function assertLineBindings(
  result: OpenPoImportBatch,
  approved: OpenPoImportBatch,
) {
  for (const target of result.result?.orders ?? []) {
    const reviewed = approved.reviewed.find(
      (item) => item.decision.sourcePoId === target.sourcePoId,
    )!;
    assert.ok(reviewed?.selected);
    const actual = (
      await pool.query(
        "SELECT id,product_id,product_name,sku,unit,quantity::text,unit_cost::text FROM purchase_order_lines WHERE order_id=$1 ORDER BY position",
        [target.orderId],
      )
    ).rows;
    const record = (
      await pool.query(
        "SELECT reviewed_decision FROM open_po_import_records WHERE order_id=$1",
        [target.orderId],
      )
    ).rows[0];
    assert.ok(record);
    const expected = [];
    for (const selected of reviewed.selected.lines) {
      const line = actual.find(
        (line) => line.product_id === selected.product.id,
      );
      assert.ok(line);
      assert.equal(line.unit, selected.source.unit);
      assert.equal(line.unit_cost, await normalized(selected.source.unitCost));
      if (target.action === "create") {
        assert.equal(
          line.quantity,
          await normalized(selected.source.outstandingQty),
        );
        assert.equal(line.product_name, selected.product.name);
        assert.equal(line.sku, selected.product.sku);
      }
      expected.push({
        sourceLineId: selected.source.sourceLineId,
        sourceLine: selected.source.line,
        orderLineId: line.id,
        productId: line.product_id,
        quantity: line.quantity,
        outstandingQty: await normalized(selected.source.outstandingQty),
        unit: line.unit,
        unitCost: line.unit_cost,
      });
    }
    assert.deepEqual(
      record.reviewed_decision.targetLines,
      expected,
      "Every immutable source binding must point to its actual exact SQL line, product, unit, quantities and cost.",
    );
  }
}
async function assertPurchaseChange(
  before: Awaited<ReturnType<typeof purchasingSnapshot>>,
  result: OpenPoImportBatch | null,
  approved: OpenPoImportBatch,
  wasCommitted = false,
) {
  const after = await purchasingSnapshot(),
    oldHeaders = new Map(before.headers.map((row) => [row.id, row.row])),
    oldLines = new Map(before.lines.map((row) => [row.id, row.row]));
  for (const [id, row] of oldHeaders)
    assert.equal(
      after.headers.find((candidate) => candidate.id === id)?.row,
      row,
      `Prior PO ${id} changed.`,
    );
  for (const [id, row] of oldLines)
    assert.equal(
      after.lines.find((candidate) => candidate.id === id)?.row,
      row,
      `Prior line ${id} changed.`,
    );
  const newTargets = (result?.result?.orders ?? []).filter(
      (target) => target.action === "create" && !oldHeaders.has(target.orderId),
    ),
    newIds = new Set(newTargets.map((target) => target.orderId));
  const addedHeaders = after.headers.filter((row) => !oldHeaders.has(row.id)),
    addedLines = after.lines.filter((row) => !oldLines.has(row.id));
  assert.deepEqual(
    addedHeaders.map((row) => row.id).sort(),
    [...newIds].sort(),
    "Only the exact expected new PO headers may be added.",
  );
  if (result) {
    const expected = approved.reviewed.filter((item) => item.selected),
      actual = result.result!;
    assert.ok(actual);
    assert.equal(
      actual.created,
      expected.filter((item) => item.decision.action === "create").length,
    );
    assert.equal(
      actual.linked,
      expected.filter((item) => item.decision.action === "link").length,
    );
    assert.equal(
      actual.skipped,
      approved.reviewed.filter((item) => !item.selected).length,
    );
    assert.deepEqual(
      actual.orders.map((item) => item.sourcePoId).sort(),
      expected.map((item) => item.decision.sourcePoId).sort(),
      "Result cardinality and source IDs must match owner-approved orders, not authorize their own extra appends.",
    );
    assert.equal(
      new Set(actual.orders.map((item) => item.orderId)).size,
      actual.orders.length,
    );
    assert.equal(
      newTargets.length,
      wasCommitted ? 0 : actual.created,
      "Fresh create approvals must append exactly one new target per approved source; committed replay must append none.",
    );
    for (const target of actual.orders) {
      const entry = expected.find(
        (item) => item.decision.sourcePoId === target.sourcePoId,
      )!;
      assert.equal(target.action, entry.decision.action);
      assert.equal(
        target.sourcePoNumber,
        approved.rows.find((row) => row.sourcePoId === target.sourcePoId)!
          .lines[0].sourcePoNumber,
      );
      if (target.action === "link")
        assert.equal(target.orderId, entry.selected!.existingOrder!.id);
      const header = after.headers.find((row) => row.id === target.orderId);
      assert.ok(header);
      assert.equal(
        target.orderNumber,
        `PO-${String(JSON.parse(header.row).number).padStart(6, "0")}`,
      );
    }
  }
  assert.ok(
    addedLines.every((line) => newIds.has(line.orderId)),
    "No lines may be inserted into another existing or unexpected order.",
  );
  let expectedLines = 0;
  for (const target of newTargets) {
    const entry = approved.reviewed.find(
      (item) => item.decision.sourcePoId === target.sourcePoId,
    )!;
    assert.ok(entry?.selected);
    expectedLines += entry.selected.lines.length;
    assert.equal(
      addedLines.filter((line) => line.orderId === target.orderId).length,
      entry.selected.lines.length,
    );
    const row = JSON.parse(
      addedHeaders.find((row) => row.id === target.orderId)!.row,
    );
    assert.equal(row.status, "Ordered");
    assert.equal(row.supplier, entry.selected.supplier.name);
    assert.equal(row.warehouse_id, entry.selected.warehouse.id);
    assert.equal(row.job_id, entry.selected.job?.id ?? null);
    assert.equal(
      row.expected_on,
      entry.selected.lines[0].source.expectedOn || null,
    );
    assert.equal(row.revision, 1);
    assert.equal(row.created_by, "owner-fixture");
    assert.equal(row.request_key, null);
    assert.equal(row.request_hash, null);
  }
  assert.equal(
    addedLines.length,
    expectedLines,
    "Exactly the approved number of new lines may be appended.",
  );
  if (result) await assertLineBindings(result, approved);
}
async function noProtectedChange(
  actor: Actor,
  batch: OpenPoImportBatch,
  status = 200,
  body: unknown = commitBody(batch),
) {
  const before = await context(0, protectedSnapshot),
    prior = await context(0, purchasingSnapshot);
  const wasCommitted = await context(0, async () => {
    const row = (
      await pool.query(
        "SELECT status FROM open_po_import_batches WHERE id=$1",
        [batch.id],
      )
    ).rows[0];
    return row.status === "committed";
  });
  const result = await call(actor, "POST", path(batch, "commit"), body, status);
  assert.deepEqual(await context(0, protectedSnapshot), before);
  await context(0, () =>
    assertPurchaseChange(
      prior,
      status === 200 ? (result as OpenPoImportBatch) : null,
      batch,
      wasCommitted,
    ),
  );
  return result as OpenPoImportBatch;
}
async function seedOrder(id: string) {
  await pool.query(
    "INSERT INTO purchase_orders(id,supplier,warehouse_id,expected_on,notes,status,revision,created_by,created_at,updated_at) VALUES($1,'Fixture supplier A','fixture-warehouse','2026-12-01','Retained original note','Partially received',3,'previous-owner','2026-11-23T10:00:00.123456Z','2026-11-23T10:00:00.123456Z')",
    [id],
  );
  await pool.query(
    "INSERT INTO purchase_order_lines(id,order_id,product_id,product_name,sku,unit,position,quantity,unit_cost) VALUES($1,$2,'fixture-product','Fixture stock','000012','box',0,12.300001,4.460001)",
    [id + "-line", id],
  );
  await pool.query(
    "INSERT INTO inventory_movements(id,product_id,warehouse_id,quantity,kind,reason,idempotency_key,created_at) VALUES($1,'fixture-product','fixture-warehouse',2.1,'receipt','Retained genuine fixture receipt',$1,'2026-11-23T10:00:00.123456Z')",
    [id + "-movement"],
  );
  await pool.query(
    "INSERT INTO purchase_receipts(id,order_id,reference,request_key,request_hash,received_by,received_at) VALUES($1,$2,'Retained receipt',$1,$3,'previous-owner','2026-11-23T10:00:00.123456Z')",
    [id + "-receipt", id, "f".repeat(64)],
  );
  await pool.query(
    "INSERT INTO purchase_receipt_lines(id,receipt_id,line_id,quantity,movement_id) VALUES($1,$2,$3,2.1,$4)",
    [id + "-receipt-line", id + "-receipt", id + "-line", id + "-movement"],
  );
  await pool.query(
    "UPDATE products SET quantity_on_hand=(SELECT sum(quantity) FROM inventory_movements WHERE product_id='fixture-product') WHERE id='fixture-product'",
  );
}
async function linkedChoice(
  actor: Actor,
  batch: OpenPoImportBatch,
  orderId: string,
) {
  const order = (await options(actor, "order")).find(
    (item: any) => item.id === orderId,
  );
  assert.ok(order);
  return choice(actor, batch, {
    action: "link",
    orderId: order.id,
    orderRevision: order.revision,
    orderFingerprint: order.fingerprint,
  });
}
try {
  for (let index = 0; index < 2; index++)
    await context(index, async () => {
      for (const role of ["owner", "sales", "operations", "installer"])
        await db.insert(usersTable).values({
          id: `${role}-fixture`,
          email: `${role}@fictional.example.invalid`,
          name: "Fictional PO import " + role,
          role,
          active: true,
          passwordHash: await hashPassword(password),
          createdAt: "2026-11-23",
          updatedAt: "2026-11-23",
        });
      await pool.query(
        "INSERT INTO suppliers(id,name,name_key,created_at,updated_at) VALUES('fixture-supplier',$1,$2,'2026-11-23','2026-11-23')",
        [
          "Fixture supplier " + (index ? "B" : "A"),
          "fixture supplier " + (index ? "b" : "a"),
        ],
      );
      await pool.query(
        "INSERT INTO warehouses(id,name,created_at,updated_at) VALUES('fixture-warehouse',$1,'2026-11-23','2026-11-23')",
        [index ? "Remote B" : "Office A"],
      );
      await pool.query(
        "INSERT INTO products(id,name,category,sku,unit,cost,price,quantity_on_hand,created_at,updated_at) VALUES('fixture-product','Fixture stock','Tile','000012','box',99.99,120.12,0,'2026-11-23','2026-11-23')",
      );
      await pool.query(
        "INSERT INTO supplier_product_aliases(id,product_id,supplier,supplier_key,supplier_sku,supplier_sku_key,approved_by,approved_at) VALUES('fixture-alias','fixture-product','Fixture supplier A','fixture supplier a','V-000012','v-000012','owner-fixture','2026-11-23')",
      );
      await pool.query(
        "INSERT INTO supplier_buy_prices(id,alias_id,unit,unit_cost,effective_on,source,approved_by,approved_at) VALUES('fixture-price','fixture-alias','box',2.310001,'2026-11-01','Retained negotiated price','owner-fixture','2026-11-23')",
      );
      await pool.query(
        "INSERT INTO jobs(id,job_number,customer_name,flooring_type,material_status,priority_level,risk_level,status,actual_revenue,actual_labor_cost,share_token,created_at,updated_at) VALUES('fixture-job','J-0001','Fixture customer','Tile','Ordered','Low','Low','Approved',430.10,35.04,'private-fixture-token','2026-11-23','2026-11-23')",
      );
      await pool.query(
        "INSERT INTO invoices(id,invoice_number,job_id,customer_name,total,paid_amount,balance_amount,status,created_at,updated_at) VALUES('fixture-invoice','I-0001','fixture-job','Fixture customer',430.10,100.01,330.09,'Partial','2026-11-23','2026-11-23')",
      );
      if (!index) await seedOrder("existing-open");
    });
  const owner = await login(0, "owner"),
    other = await login(1, "owner");
  for (const role of ["sales", "operations", "installer"]) {
    const actor = await login(0, role);
    await call(actor, "GET", "/open-po-imports", undefined, 403);
    await call(
      actor,
      "POST",
      "/open-po-imports/preview",
      input("role-" + role),
      403,
    );
  }
  await request(app)
    .get("/api/open-po-imports")
    .set("Host", owner.host)
    .expect(401);
  await request(app)
    .post("/api/open-po-imports/preview")
    .set("Host", owner.host)
    .set("Cookie", owner.cookie)
    .send(input("csrf"))
    .expect(403);
  await request(app)
    .post("/api/open-po-imports/preview")
    .set("Host", owner.host)
    .set("Origin", "https://b.import.test")
    .set("Cookie", owner.cookie)
    .set("x-csrf-token", owner.csrf)
    .send(input("origin"))
    .expect(403);
  checks.push(
    "actual normal password sessions enforce owner roles, CSRF and Origin before import work",
  );
  await call(owner, "POST", "/auth/persona", { role: "sales" });
  await call(owner, "GET", "/open-po-imports", undefined, 403);
  await call(
    owner,
    "POST",
    "/open-po-imports/preview",
    input("preview-role"),
    403,
  );
  await call(owner, "POST", "/auth/persona", { role: null });
  checks.push("actual owner role preview cannot read or mutate imports");
  await call(
    { ...owner, host: other.host },
    "GET",
    "/open-po-imports",
    undefined,
    401,
  );
  await request(app)
    .get("/api/open-po-imports")
    .set("Host", "unknown.import.test")
    .expect(421);
  const intakeBefore = await context(0, protectedSnapshot),
    purchaseIntakeBefore = await context(0, purchasingSnapshot);
  const initial = await preview(owner, "00001"),
    same = await preview(owner, "00001");
  assert.equal(initial.id, same.id);
  assert.equal(initial.rows[0].sourcePoId, "00001");
  assert.equal(initial.rows[0].lines[0].sourcePoNumber, "000078");
  assert.equal(initial.rows[0].lines[0].unitCost, "4.460001");
  assert.equal(initial.rows[0].lines[0].outstandingQty, "10.000001");
  checks.push(
    "source IDs/numbers/decimal strings survive preview and exact source/batch retry",
  );
  await call(other, "GET", `/open-po-imports/${initial.id}`, undefined, 404);
  assert.equal((await call(other, "GET", "/open-po-imports")).length, 0);
  await call(
    owner,
    "POST",
    "/open-po-imports/preview",
    { ...input("foreign-selector"), workspaceKey: "import-b" },
    400,
  );
  checks.push(
    "two actual tenant DBs, cookies, unknown hosts and strict bodies prevent cross-company fallback",
  );
  const raw = await request(app)
    .get(`/api/open-po-imports/${initial.id}/source`)
    .set("Host", owner.host)
    .set("Cookie", owner.cookie)
    .expect(200);
  assert.equal(Buffer.from(raw.body).toString("utf8"), input("00001").csv);
  assert.equal(
    initial.sourceSha256,
    createHash("sha256")
      .update(Buffer.from(input("00001").csv, "utf8"))
      .digest("hex"),
  );
  assert.match(raw.headers["content-disposition"], /^attachment/);
  assert.match(raw.headers["content-type"], /^application\/octet-stream/);
  assert.equal(raw.headers["cache-control"], "private, no-store");
  checks.push(
    "original BOM/CRLF bytes and SHA-256 are preserved in an authenticated forced attachment",
  );
  await call(
    owner,
    "POST",
    "/open-po-imports/preview",
    { ...input("00001"), csv: input("00001").csv + " " },
    409,
  );
  await call(
    owner,
    "POST",
    "/open-po-imports/preview",
    { ...input("future"), cutoverAt: "2099-01-01T00:00:00Z" },
    400,
  );
  checks.push(
    "a source identity cannot be replaced; future or invalid cutover timestamps are refused",
  );
  const approved = await authorize(owner, initial);
  assert.deepEqual(
    await context(0, protectedSnapshot),
    intakeBefore,
    "Every protected business table must remain unchanged throughout preview/review/approval.",
  );
  assert.deepEqual(await context(0, purchasingSnapshot), purchaseIntakeBefore);
  const before = await context(0, protectedSnapshot),
    oldOrder = await context(0, purchasingSnapshot);
  const [first, replayed] = await Promise.all([
    call(owner, "POST", path(approved, "commit"), commitBody(approved)),
    call(owner, "POST", path(approved, "commit"), commitBody(approved)),
  ]);
  assert.equal(first.result.created, 1);
  assert.deepEqual(first.result, replayed.result);
  assert.deepEqual(await context(0, protectedSnapshot), before);
  await context(0, () => assertPurchaseChange(oldOrder, first, approved));
  checks.push(
    "concurrent approved commits create once while every prior receipt/stock/financial/price/queue table remains unchanged",
  );
  const target = first.result.orders[0];
  assert.equal(target.sourcePoNumber, "000078");
  assert.match(target.orderNumber, /^PO-\d{6}$/);
  await context(0, async () => {
    const line = (
      await pool.query(
        "SELECT quantity::text,unit_cost::text FROM purchase_order_lines WHERE order_id=$1",
        [target.orderId],
      )
    ).rows;
    assert.deepEqual(line, [{ quantity: "10.000001", unit_cost: "4.460001" }]);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM purchase_receipts WHERE order_id=$1",
          [target.orderId],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query("SELECT status FROM purchase_orders WHERE id=$1", [
          target.orderId,
        ])
      ).rows[0].status,
      "Ordered",
    );
  });
  checks.push(
    "only exact remaining quantities and source negotiated costs enter an Ordered PO; catalog prices and prior receipts are never substituted",
  );
  const again = await noProtectedChange(owner, approved);
  assert.deepEqual(again.result, first.result);
  await noProtectedChange(owner, approved, 409, {
    ...commitBody(approved),
    approvalFingerprint: "f".repeat(64),
  });
  checks.push(
    "lost-response replay keeps the original target IDs and rejects altered approval payloads",
  );
  const provenance = await call(
    owner,
    "GET",
    `/open-po-imports/provenance/${target.orderId}`,
  );
  assert.equal(provenance.record.sourceData.lines[0].receivedQty, "2.1");
  assert.equal(
    provenance.record.reviewedDecision.targetLines[0].sourceLineId,
    "000001",
  );
  assert.equal(
    provenance.record.reviewedDecision.targetLines[0].quantity,
    "10.000001",
  );
  assert.ok(provenance.record.reviewedDecision.targetLines[0].orderLineId);
  checks.push(
    "immutable provenance retains original quantities, supplier identity and source-line to Works-line mapping",
  );
  const core = (await call(owner, "GET", "/inventory/purchase-orders")).find(
    (order: any) => order.id === target.orderId,
  );
  assert.equal(core.importOrigin.sourcePoNumber, "000078");
  assert.equal(core.importOrigin.action, "create");
  assert.equal(core.lines[0].receivedQuantity, 0);
  checks.push(
    "ordinary PO DTO distinguishes original source number from Works number and starts with no fabricated receipts",
  );
  const duplicate = await preview(owner, "duplicate-batch", [
    sourceLine("00001"),
  ]);
  assert.ok(duplicate.rows[0].imported);
  await review(owner, duplicate, [await choice(owner, duplicate)], 409);
  checks.push(
    "already imported source IDs cannot be duplicated by a new batch or workspace-label namespace",
  );
  const skipped = await authorize(owner, duplicate, {
    sourcePoId: duplicate.rows[0].sourcePoId,
    action: "skip",
    note: "Already linked source retained; no duplicate PO is authorized",
  });
  const skippedResult = await noProtectedChange(owner, skipped);
  assert.equal(skippedResult.result!.skipped, 1);
  assert.equal(skippedResult.result!.orders.length, 0);
  checks.push(
    "an explicitly approved all-skip review commits only immutable source history and creates no PO or line",
  );
  const link = await preview(owner, "link-existing", [
    sourceLine("link-existing", {
      cancelled_qty: "0",
      outstanding_qty: "10.200001",
    }),
  ]);
  const linkApproved = await authorize(
    owner,
    link,
    await linkedChoice(owner, link, "existing-open"),
  );
  const linked = await noProtectedChange(owner, linkApproved);
  assert.equal(linked.result.linked, 1);
  assert.equal(linked.result.orders[0].orderId, "existing-open");
  checks.push(
    "explicit existing-order links preserve all header/line data and genuine prior receipt history without creating a new PO",
  );
  for (const [name, changes] of [
    ["missing-cost", { unit_cost: "" }],
    ["foreign-currency", { currency: "EUR" }],
    ["unit-mismatch", { unit: "sq ft" }],
  ] as const) {
    const batch = await preview(owner, name, [sourceLine(name, changes)]);
    await review(owner, batch, [await choice(owner, batch)], 409);
  }
  checks.push(
    "missing costs, unsupported currency and incompatible units are blocked rather than guessed or converted",
  );
  const zero = await preview(owner, "zero-cost", [
    sourceLine("zero-cost", { unit_cost: "0" }),
  ]);
  const zeroChoice = await choice(owner, zero);
  await review(owner, zero, [zeroChoice], 409);
  zeroChoice.lines![0].zeroCostReason =
    "Supplier confirmed a genuine zero-cost replacement";
  await noProtectedChange(owner, await authorize(owner, zero, zeroChoice));
  checks.push(
    "zero is accepted only with explicit genuine-zero evidence; missing never becomes zero",
  );
  const mixed = await preview(owner, "mixed-header", [
    sourceLine("mixed-header"),
    sourceLine("mixed-header", {
      source_line_id: "000002",
      warehouse_ref: "Different source warehouse",
    }),
  ]);
  assert.ok(mixed.rows[0].errors.length);
  await review(owner, mixed, [await choice(owner, mixed)], 409);
  const repeated = await preview(owner, "duplicate-product", [
    sourceLine("duplicate-product"),
    sourceLine("duplicate-product", { source_line_id: "000002" }),
  ]);
  await review(owner, repeated, [await choice(owner, repeated)], 409);
  checks.push(
    "mixed headers and duplicate product mappings cannot be merged or averaged into misleading order lines",
  );
  const closed = await preview(owner, "closed-lines", [
    sourceLine("closed-lines"),
    sourceLine("closed-lines", {
      source_line_id: "000002",
      ordered_qty: "1",
      received_qty: "1",
      cancelled_qty: "0",
      outstanding_qty: "0",
    }),
  ]);
  const closeChoice = await choice(owner, closed);
  await review(owner, closed, [closeChoice], 409);
  closeChoice.lines![1] = {
    line: 3,
    action: "skip",
    note: "Already fully received before cutover",
  };
  await noProtectedChange(owner, await authorize(owner, closed, closeChoice));
  checks.push(
    "zero-remaining source lines remain retained and need explicit skip; they never become a receipt or extra order quantity",
  );
  const staleProduct = await preview(owner, "stale-product"),
    staleApproved = await authorize(owner, staleProduct);
  await context(0, () =>
    pool.query(
      "UPDATE products SET revision=revision+1,unit='case',updated_at='2026-11-24T00:00:00Z' WHERE id='fixture-product'",
    ),
  );
  await noProtectedChange(owner, staleApproved, 409);
  await context(0, () =>
    pool.query(
      "UPDATE products SET revision=revision+1,unit='box',updated_at='2026-11-24T00:01:00Z' WHERE id='fixture-product'",
    ),
  );
  checks.push(
    "changed selected product/unit revisions invalidate approved source payloads before any PO is created",
  );
  const staleSupplier = await preview(owner, "stale-supplier"),
    supplierApproved = await authorize(owner, staleSupplier);
  await context(0, () =>
    pool.query(
      "UPDATE suppliers SET revision=revision+1,active=false,updated_at='2026-11-24T00:00:00Z' WHERE id='fixture-supplier'",
    ),
  );
  await noProtectedChange(owner, supplierApproved, 409);
  await context(0, () =>
    pool.query(
      "UPDATE suppliers SET revision=revision+1,active=true,updated_at='2026-11-24T00:01:00Z' WHERE id='fixture-supplier'",
    ),
  );
  checks.push(
    "inactive or changed suppliers cannot be silently rebound after owner approval",
  );
  const staleWh = await preview(owner, "stale-warehouse"),
    whApproved = await authorize(owner, staleWh);
  await context(0, () =>
    pool.query(
      "UPDATE warehouses SET updated_at='2026-11-24T00:02:00Z' WHERE id='fixture-warehouse'",
    ),
  );
  await noProtectedChange(owner, whApproved, 409);
  checks.push("warehouse version changes require explicit fresh review");
  const jobBatch = await preview(owner, "stale-job", [
      sourceLine("stale-job", { job_ref: "J-0001" }),
    ]),
    job = (await options(owner, "job")).find(
      (item: any) => item.id === "fixture-job",
    );
  const jobApproved = await authorize(
    owner,
    jobBatch,
    await choice(owner, jobBatch, {
      jobId: job.id,
      jobRevision: job.revision,
      jobUpdatedAt: job.updatedAt,
    }),
  );
  await context(0, () =>
    pool.query(
      "UPDATE jobs SET revision=revision+1,updated_at='2026-11-24T00:03:00Z' WHERE id='fixture-job'",
    ),
  );
  await noProtectedChange(owner, jobApproved, 409);
  checks.push(
    "an explicit same-tenant job link is version-bound, and import never creates jobs or bookings",
  );
  const foreign = await preview(owner, "foreign-link");
  await review(
    owner,
    foreign,
    [{ ...(await choice(owner, foreign)), supplierId: "only-in-other-tenant" }],
    409,
  );
  checks.push(
    "foreign or nonexistent selected master IDs cannot resolve through another tenant",
  );
  await context(0, () => seedOrder("receipt-race"));
  const receiptBatch = await preview(owner, "receipt-race", [
    sourceLine("receipt-race", {
      cancelled_qty: "0",
      outstanding_qty: "10.200001",
    }),
  ]);
  const receiptApproved = await authorize(
    owner,
    receiptBatch,
    await linkedChoice(owner, receiptBatch, "receipt-race"),
  );
  await call(
    owner,
    "POST",
    "/inventory/purchase-orders/receipt-race/receive",
    {
      revision: 3,
      idempotencyKey: "receipt-race-" + randomUUID(),
      reference: "Actual fixture delivery after approval",
      lines: [
        {
          lineId: "receipt-race-line",
          quantity: 0,
          binId: null,
          damagedQuantity: 1,
          damageNote: "Damaged in transit",
        },
      ],
    },
    201,
  );
  await noProtectedChange(owner, receiptApproved, 409);
  checks.push(
    "an actual damage-only receiving action after approval invalidates the frozen receipt/order snapshot without replaying or overwriting receipts",
  );
  await context(0, () => seedOrder("legacy-receipt-change"));
  const legacyReceiptBatch = await preview(owner, "legacy-receipt-change", [
    sourceLine("legacy-receipt-change", {
      cancelled_qty: "0",
      outstanding_qty: "10.200001",
    }),
  ]);
  const legacyReceiptApproved = await authorize(
    owner,
    legacyReceiptBatch,
    await linkedChoice(owner, legacyReceiptBatch, "legacy-receipt-change"),
  );
  await context(0, async () => {
    await pool.query(
      "INSERT INTO purchase_receipts(id,order_id,reference,request_key,request_hash,received_by,received_at) VALUES('late-damage','legacy-receipt-change','Retained damage record','late-damage',$1,'previous-owner','2026-11-23')",
      ["f".repeat(64)],
    );
    await pool.query(
      "INSERT INTO purchase_receipt_lines(id,receipt_id,line_id,quantity,damaged_quantity,damage_note,movement_id) VALUES('late-damage-line','late-damage','legacy-receipt-change-line',0,1,'Damaged original shipment',NULL)",
    );
  });
  await noProtectedChange(owner, legacyReceiptApproved, 409);
  checks.push(
    "the complete receipt digest catches injected legacy damage history even when accepted quantities and PO revision remain unchanged",
  );
  await context(0, () => seedOrder("duplicate-target"));
  const duplicateTargets = await preview(owner, "duplicate-targets", [
    sourceLine("first-source", {
      cancelled_qty: "0",
      outstanding_qty: "10.200001",
    }),
    sourceLine("second-source", {
      cancelled_qty: "0",
      outstanding_qty: "10.200001",
    }),
  ]);
  const duplicateChoices = await Promise.all(
    duplicateTargets.rows.map((row) =>
      linkedChoice(
        owner,
        { ...duplicateTargets, rows: [row] },
        "duplicate-target",
      ),
    ),
  );
  await review(owner, duplicateTargets, duplicateChoices, 409);
  checks.push(
    "one existing Works PO cannot be claimed by two different source identities in the same saved review",
  );
  await context(0, async () => {
    await assert.rejects(
      pool.query("UPDATE open_po_import_approvals SET review_note='changed'"),
      /immutable/,
    );
    await assert.rejects(
      pool.query("DELETE FROM open_po_import_records"),
      /immutable/,
    );
    await assert.rejects(
      pool.query(
        "UPDATE open_po_import_batches SET source_csv='changed' WHERE id=$1",
        [initial.id],
      ),
      /immutable/,
    );
  });
  checks.push(
    "SQL rejects source, approval and accepted provenance mutation independently of UI",
  );
  await context(0, async () => {
    const gate = await pool.connect();
    try {
      await gate.query("BEGIN");
      await gate.query(
        "SELECT pg_advisory_xact_lock(hashtext('open-po-import'))",
      );
      const blocked = call(
        owner,
        "POST",
        "/open-po-imports/preview",
        input("demoted-owner"),
        403,
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const row = (
          await gate.query(
            "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
          )
        ).rows[0];
        if (row.n > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        waiting,
        true,
        "The already-authenticated request must reach the transaction guard before demotion.",
      );
      await pool.query(
        "UPDATE users SET role='operations' WHERE id='owner-fixture'",
      );
      await gate.query("COMMIT");
      const outcome = await blocked;
      if ("error" in outcome) throw outcome.error;
      await pool.query(
        "UPDATE users SET role='owner' WHERE id='owner-fixture'",
      );
    } finally {
      await gate.query("ROLLBACK");
      gate.release();
    }
  });
  checks.push(
    "a request authenticated before concurrent owner demotion rechecks the persisted role inside its transaction and is refused",
  );
  assert.equal(providerCalls, 0);
  console.log(
    JSON.stringify({ openPoMigration: "passed", providerCalls, checks }),
  );
} finally {
  globalThis.fetch = originalFetch;
  await closeWorkspaceConnections();
}
