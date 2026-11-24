/** Actual HTTP/auth + disposable PG. Azure Blob and Intuit transport are explicit
 * synthetic fixtures; no live provider, mail, accounting or storage is touched. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import {
  db,
  pool,
  usersTable,
  closeWorkspaceConnections,
  quickbooksConnectionsTable,
  quickbooksEntityMappingsTable,
} from "@workspace/db";
import { inWorkspace, workspaceConfigs } from "@workspace/db/workspace";
import { hashPassword } from "../src/lib/auth";
import { encryptSecret } from "../src/lib/quickbooks";
import { eq } from "drizzle-orm";
import app from "../src/app";
assert.equal(workspaceConfigs.length, 2);
for (const workspace of workspaceConfigs) {
  const url = new URL(workspace.databaseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.pathname, /^\/bill_coverage_[a-f0-9]{32}_[ab]$/);
}
const context = <T>(index: number, work: () => Promise<T>) =>
  inWorkspace(workspaceConfigs[index], work);
const checks: string[] = [],
  originalFetch = globalThis.fetch;
const blobs = new Map<
  string,
  { bytes: Buffer; headers: Record<string, string> }
>();
const remoteBills = new Map<string, any>(),
  remoteInvoices = new Map<string, any>(),
  adjustments = new Map<string, any>();
let unexpectedCalls = 0,
  financialProviderPosts = 0,
  refreshCalls = 0,
  one401 = false,
  quantityOnHand = 15;
let providerGate: { entered: () => void; wait: Promise<void> } | undefined;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = new URL(
      typeof input === "string" ? input : (input.url ?? input.href),
    ),
    method = init?.method ?? "GET";
  if (url.hostname === "127.0.0.1" && url.pathname === "/token")
    return Response.json({
      access_token: "synthetic-storage-token",
      expires_on: Math.floor(Date.now() / 1000) + 3600,
    });
  if (url.hostname === "fixtureaccount.blob.core.windows.net") {
    if (method === "PUT") {
      assert.equal(new Headers(init?.headers).get("If-None-Match"), "*");
      assert.ok(!blobs.has(url.href));
      blobs.set(url.href, {
        bytes: Buffer.from(init!.body as any),
        headers: Object.fromEntries(new Headers(init?.headers)),
      });
      return new Response(null, { status: 201 });
    }
    const blob = blobs.get(url.href);
    if (!blob)
      return new Response(null, {
        status: 404,
        headers: { "x-ms-error-code": "BlobNotFound" },
      });
    return new Response(method === "HEAD" ? null : blob.bytes, {
      status: 200,
      headers: { ...blob.headers, "content-length": String(blob.bytes.length) },
    });
  }
  if (
    url.hostname === "oauth.platform.intuit.com" &&
    url.pathname.includes("/tokens/bearer")
  ) {
    refreshCalls++;
    return Response.json({
      access_token: "synthetic-refreshed-access",
      refresh_token: "synthetic-refreshed-refresh",
      expires_in: 3600,
      x_refresh_token_expires_in: 86400,
    });
  }
  if (
    url.hostname === "sandbox-quickbooks.api.intuit.com" &&
    url.pathname.startsWith("/v3/company/123/")
  ) {
    if (method !== "GET") {
      financialProviderPosts++;
      throw Error("Financial provider writes are forbidden in this fixture");
    }
    if (one401) {
      one401 = false;
      return Response.json({}, { status: 401 });
    }
    const path = url.pathname.slice("/v3/company/123".length);
    if (path === "/item/2")
      return Response.json({
        Item: {
          Id: "2",
          SyncToken: "9",
          Active: true,
          Type: "Inventory",
          TrackQtyOnHand: true,
          QtyOnHand: quantityOnHand,
          InvStartDate: "2026-01-01",
          Sku: "000012",
          Name: "Fictional material",
        },
      });
    if (path === "/vendor/1")
      return Response.json({
        Vendor: {
          Id: "1",
          SyncToken: "7",
          Active: true,
          DisplayName: "Fictional Supply",
        },
      });
    if (path === "/companyinfo/123") {
      if (providerGate) {
        const gate = providerGate;
        providerGate = undefined;
        gate.entered();
        await gate.wait;
      }
      return Response.json({
        CompanyInfo: {
          Id: "1",
          Country: "US",
          CompanyName: "Synthetic US company",
        },
      });
    }
    if (path === "/preferences")
      return Response.json({
        Preferences: { CurrencyPrefs: { HomeCurrency: { value: "USD" } } },
      });
    if (path === "/query") {
      const statement = url.searchParams.get("query")!;
      if (statement.includes("CreditMemo"))
        return Response.json({ QueryResponse: { CreditMemo: [] } });
      if (statement.includes("RefundReceipt"))
        return Response.json({ QueryResponse: { RefundReceipt: [] } });
    }
    if (path.startsWith("/bill/") && remoteBills.has(path.slice(6)))
      return Response.json({ Bill: remoteBills.get(path.slice(6)) });
    if (path.startsWith("/invoice/") && remoteInvoices.has(path.slice(9)))
      return Response.json({ Invoice: remoteInvoices.get(path.slice(9)) });
    if (
      path.startsWith("/inventoryadjustment/") &&
      adjustments.has(path.slice(21))
    )
      return Response.json({
        InventoryAdjustment: adjustments.get(path.slice(21)),
      });
  }
  unexpectedCalls++;
  throw Error(
    "Unexpected synthetic transport endpoint: " + url.origin + url.pathname,
  );
}) as typeof fetch;
const password = "Fictional-coverage-workflow-password";
type Actor = { host: string; cookie: string; csrf: string };
function http(actor: Actor, method: string, path: string) {
  const req = (request(app) as any)
    [method.toLowerCase()]("/api" + path)
    .set("Host", actor.host)
    .set("Origin", "https://" + actor.host)
    .set("Cookie", actor.cookie);
  return method === "GET" ? req : req.set("x-csrf-token", actor.csrf);
}
async function call(
  actor: Actor,
  method: string,
  path: string,
  input?: unknown,
  status = 200,
) {
  const response = await (input === undefined
    ? http(actor, method, path)
    : http(actor, method, path).send(input));
  assert.equal(
    response.status,
    status,
    `${method} ${path}: ${response.status} ${JSON.stringify(response.body).slice(0, 600)}`,
  );
  return response.body;
}
async function login(index: number, role: string): Promise<Actor> {
  const host = `${index ? "b" : "a"}.coverage.test`;
  const response = await request(app)
    .post("/api/auth/login")
    .set("Host", host)
    .set("Origin", "https://" + host)
    .send({ email: `${role}@coverage.example.invalid`, password });
  assert.equal(response.status, 200);
  return {
    host,
    cookie: response.headers["set-cookie"][0].split(";")[0],
    csrf: response.body.csrfToken,
  };
}
const billSource = (quantity: string, number: string, postedId?: string) => {
  const totalCents = Math.round(Number(quantity) * 446),
    prepared = {
      DocNumber: number,
      TxnDate: "2026-11-23",
      VendorRef: { value: "1" },
      PrivateNote: "Synthetic reviewed supplier source",
      Line: [
        {
          DetailType: "ItemBasedExpenseLineDetail",
          Amount: totalCents / 100,
          Description: "Fictional material",
          ItemBasedExpenseLineDetail: {
            ItemRef: { value: "2" },
            Qty: Number(quantity),
            UnitPrice: 4.46,
          },
        },
      ],
    };
  if (postedId)
    remoteBills.set(postedId, {
      ...prepared,
      Id: postedId,
      TotalAmt: totalCents / 100,
      SyncToken: "0",
      CurrencyRef: { value: "USD" },
      LinkedTxn: [],
    });
  return {
    mode: postedId ? "sandbox" : "review",
    supplier: "Fictional Supply",
    billNumber: number,
    billDate: "2026-11-23",
    lines: [
      {
        supplierSku: "000001",
        internalSku: "000012",
        productName: "Fictional material",
        unit: "sqft",
        expectedUnitCost: "4.460000",
        priceEffectiveOn: "2026-01-01",
        priceSource: "Fictional agreed price",
        quantity,
        billedUnitCost: "4.460000",
        totalCents,
        ...(postedId
          ? {
              sourceIdentity: {
                version: 1,
                binding: "original_preparation",
                product: { id: "product" },
                alias: { id: "alias" },
                price: { id: "price" },
              },
            }
          : {}),
      },
    ],
    ...(postedId ? { realmId: "123", quickBooksBill: prepared, postedId } : {}),
  };
};
const coverageChoice = (
  rows: Array<{
    receiptLineId: string;
    billId: string;
    billLineIndex: number;
    quantity: string;
    varianceNote: string;
    existingAllocationId?: string;
  }>,
) => ({
  billIds: [...new Set(rows.map((row) => row.billId))],
  allocations: rows,
  note: "Owner verified exact fictional receipt and bill quantities",
});
const allocation = (
  receiptLineId: string,
  billId: string,
  quantity: string,
  existingAllocationId?: string,
) => ({
  receiptLineId,
  billId,
  quantity,
  billLineIndex: 0,
  varianceNote: "",
  ...(existingAllocationId ? { existingAllocationId } : {}),
});
async function approve(
  actor: Actor,
  choice: ReturnType<typeof coverageChoice>,
) {
  const preview = await call(
    actor,
    "POST",
    "/quickbooks/receipt-coverage/preview",
    choice,
  );
  const body = {
    choice,
    fingerprint: preview.fingerprint,
    requestKey: randomUUID(),
    confirmQuantities: true,
    confirmPriceVariances: true,
    confirmSourceIdentities: true,
  };
  const saved = await call(
    actor,
    "POST",
    "/quickbooks/receipt-coverage/approve",
    body,
    201,
  );
  return { body, saved, preview };
}
async function seed(index: number, encoded: string) {
  await context(index, async () => {
    for (const role of ["owner", "owner2", "sales", "operations", "installer"])
      await db.insert(usersTable).values({
        id: role,
        email: `${role}@coverage.example.invalid`,
        name: role,
        role: role === "owner2" ? "owner" : (role as any),
        passwordHash: encoded,
        createdAt: "2026-11-23",
        updatedAt: "2026-11-23",
      });
    await pool.query(
      "INSERT INTO products(id,name,category,sku,supplier,unit,quantity_on_hand,created_at,updated_at) VALUES('product','Fictional material','Tile','000012','Fictional Supply','sqft',18,'2026-11-23','2026-11-23')",
    );
    await pool.query(
      "INSERT INTO warehouses(id,name,created_at,updated_at) VALUES('warehouse','Fictional office','2026-11-23','2026-11-23')",
    );
    await pool.query(
      "INSERT INTO supplier_product_aliases(id,product_id,supplier,supplier_key,supplier_sku,supplier_sku_key,approved_by,approved_at) VALUES('alias','product','Fictional Supply','fictional supply','000001','000001','owner','2026-11-23')",
    );
    await pool.query(
      "INSERT INTO supplier_buy_prices(id,alias_id,unit,unit_cost,effective_on,source,approved_by,approved_at) VALUES('price','alias','sqft',4.46,'2026-01-01','Fictional agreed price','owner','2026-11-23')",
    );
    for (const n of [1, 2]) {
      await pool.query(
        "INSERT INTO purchase_orders(id,warehouse_id,supplier,notes,status,created_by,created_at,updated_at) VALUES($1,'warehouse','Fictional Supply','','Partially received','owner','2026-11-23','2026-11-23')",
        [`po${n}`],
      );
      await pool.query(
        "INSERT INTO purchase_order_lines(id,order_id,product_id,product_name,sku,unit,position,quantity,unit_cost) VALUES($1,$2,'product','Fictional material','000012','sqft',0,20,4.46)",
        [`line${n}`, `po${n}`],
      );
      await pool.query(
        "INSERT INTO inventory_movements(id,product_id,warehouse_id,quantity,kind,reason,idempotency_key,acquisition_unit_cost,created_at) VALUES($1,'product','warehouse',10,'receipt','Synthetic accepted stock',$1,4.46,'2026-11-23')",
        [`movement${n}`],
      );
      await pool.query(
        "INSERT INTO purchase_receipts(id,order_id,reference,request_key,request_hash,received_by,received_at) VALUES($1,$2,$1,$1,$1,'owner','2026-11-23')",
        [`receipt${n}`, `po${n}`],
      );
      await pool.query(
        "INSERT INTO purchase_receipt_lines(id,receipt_id,line_id,movement_id,quantity) VALUES($1,$2,$3,$4,10)",
        [`r${n}`, `receipt${n}`, `line${n}`, `movement${n}`],
      );
    }
    for (const [id, qty, number] of [
      ["b1", "6", "000081"],
      ["b2", "14", "000082"],
      ["b3", "10", "000083"],
    ])
      await pool.query(
        "INSERT INTO quickbooks_sync_jobs(id,idempotency_key,entity_type,local_id,action,status,payload,created_at,updated_at) VALUES($1,$1,'vendor_bill',$1,'create','reviewed',$2,'2026-11-23','2026-11-23')",
        [id, billSource(qty, number)],
      );
    await pool.query(
      "INSERT INTO customers(id,name,created_at,updated_at) VALUES('customer','Fictional customer','2026-11-23','2026-11-23')",
    );
    await pool.query(
      "INSERT INTO jobs(id,job_number,customer_id,customer_name,flooring_type,material_status,priority_level,risk_level,status,created_at,updated_at) VALUES('job','J-0001','customer','Fictional customer','Tile','Received','Medium','Low','In Progress','2026-11-23','2026-11-23')",
    );
    for (const [id, kind, qty, issue, slices] of [
      [
        "issue1",
        "consume",
        -10,
        null,
        [
          {
            source: "purchase_order",
            sourceMovementId: "movement1",
            quantity: 10,
            unitCost: "4.460000",
          },
        ],
      ],
      [
        "issue2",
        "consume",
        -5,
        null,
        [
          {
            source: "purchase_order",
            sourceMovementId: "movement2",
            quantity: 5,
            unitCost: "4.460000",
          },
        ],
      ],
      [
        "return1",
        "return",
        2,
        "issue1",
        [
          {
            source: "purchase_order",
            sourceMovementId: "movement1",
            quantity: 2,
            unitCost: "4.460000",
          },
        ],
      ],
      [
        "return2",
        "return",
        1,
        "issue2",
        [
          {
            source: "purchase_order",
            sourceMovementId: "movement2",
            quantity: 1,
            unitCost: "4.460000",
          },
        ],
      ],
    ] as const)
      await pool.query(
        "INSERT INTO inventory_movements(id,product_id,job_id,warehouse_id,quantity,kind,return_of_movement_id,cost_allocations,reason,idempotency_key,created_at) VALUES($1,'product','job','warehouse',$2,$3,$4,$5,'Synthetic job movement',$1,'2026-11-23T18:00:00Z')",
        [id, qty, kind, issue, JSON.stringify(slices)],
      );
    await pool.query(
      "INSERT INTO invoices(id,invoice_number,job_id,customer_id,customer_name,status,line_items,created_at,updated_at) VALUES('invoice','INV-0001','job','customer','Fictional customer','Sent',$1,'2026-11-23','2026-11-23')",
      [
        JSON.stringify([
          {
            id: "invoice-line",
            productId: "product",
            description: "Fictional material",
            category: "Materials",
            quantity: 15,
            unitPrice: 6,
          },
        ]),
      ],
    );
  });
}
try {
  const encoded = await hashPassword(password);
  await seed(0, encoded);
  await seed(1, encoded);
  const owner = await login(0, "owner"),
    owner2 = await login(0, "owner2"),
    other = await login(1, "owner");
  for (const role of ["sales", "operations", "installer"]) {
    const actor = await login(0, role);
    await call(
      actor,
      "GET",
      "/quickbooks/receipt-coverage/options?billId=b1",
      undefined,
      403,
    );
    await call(
      actor,
      "GET",
      "/quickbooks/inventory-accounting-cases/options?productId=product",
      undefined,
      403,
    );
  }
  checks.push("actual owner required for coverage and accounting history");
  await call(owner, "POST", "/auth/persona", { role: "operations" });
  await call(
    owner,
    "GET",
    "/quickbooks/receipt-coverage/options?billId=b1",
    undefined,
    403,
  );
  await call(owner, "POST", "/auth/persona", { role: null });
  checks.push("role preview cannot obtain owner coverage access");
  await call(
    { ...owner, csrf: "wrong" },
    "POST",
    "/quickbooks/receipt-coverage/preview",
    coverageChoice([allocation("r1", "b1", "1")]),
    403,
  );
  checks.push("CSRF blocks approval mutations");
  const local = await approve(
    owner,
    coverageChoice([
      allocation("r1", "b1", "6"),
      allocation("r1", "b2", "4"),
      allocation("r2", "b2", "10"),
    ]),
  );
  assert.equal(local.saved.allocations.length, 3);
  assert.equal(local.preview.hasHistoricalIdentities, true);
  assert.ok(
    local.saved.allocations.every(
      (row: any) =>
        row.mode === "local_review" && row.providerBoundQuantity === "0.000000",
    ),
  );
  checks.push(
    "many-to-many partial receipt/bill coverage records exact original costs locally without QuickBooks",
  );
  assert.equal(
    (
      await call(
        owner,
        "POST",
        "/quickbooks/receipt-coverage/approve",
        local.body,
      )
    ).replayed,
    true,
  );
  await call(
    owner,
    "POST",
    "/quickbooks/receipt-coverage/approve",
    {
      ...local.body,
      choice: { ...local.body.choice, note: "Changed immutable approval note" },
    },
    409,
  );
  checks.push("stable request replay cannot create or replace coverage");
  await call(
    owner,
    "POST",
    "/quickbooks/receipt-coverage/preview",
    coverageChoice([allocation("r1", "b3", "0.000001")]),
    409,
  );
  checks.push("covered receipt cannot be reused by another bill");
  const otherOptions = await call(
    other,
    "GET",
    "/quickbooks/receipt-coverage/options?billId=b1",
  );
  assert.equal(otherOptions.allocations.length, 0);
  checks.push("same identifiers in second tenant do not share allocations");
  const manualChoice = {
    productId: "product",
    jobId: "job",
    returnIds: ["return1", "return2"],
    note: "Owner recorded missing original company evidence",
  };
  const manualPreview = await call(
    owner,
    "POST",
    "/quickbooks/inventory-accounting-cases/preview",
    manualChoice,
  );
  assert.equal(manualPreview.plan.kind, "manual_review");
  const manualBody = {
    choice: manualChoice,
    fingerprint: manualPreview.fingerprint,
    requestKey: randomUUID(),
    confirmNoFinancialPosting: true,
  };
  const manualCase = await call(
    owner,
    "POST",
    "/quickbooks/inventory-accounting-cases",
    manualBody,
    201,
  );
  assert.equal(manualCase.case.kind, "manual_review");
  assert.equal(
    (
      await call(
        owner,
        "POST",
        "/quickbooks/inventory-accounting-cases",
        manualBody,
      )
    ).replayed,
    true,
  );
  await call(
    owner,
    "POST",
    `/quickbooks/inventory-accounting-cases/${manualCase.case.id}/verify-adjustment`,
    {
      requestKey: randomUUID(),
      note: "Cannot fabricate provider confirmation",
      adjustmentId: "900",
    },
    409,
  );
  checks.push("durable local manual case never becomes provider confirmation");
  const pdf = Buffer.from(
    "%PDF-1.4\nFictional supplier original retained byte for byte\n%%EOF\n",
  );
  const uploaded = await http(
    owner,
    "POST",
    "/storage/files/vendor-bill-document?recordId=b1",
  )
    .set("Content-Type", "application/octet-stream")
    .set("x-file-name", encodeURIComponent("Original supplier 000081.pdf"))
    .send(pdf);
  assert.equal(uploaded.status, 201);
  const claimBody = {
    objectPath: uploaded.body.objectPath,
    requestKey: randomUUID(),
  };
  const original = await call(
    owner,
    "POST",
    "/quickbooks/vendor-bills/b1/documents",
    claimBody,
    201,
  );
  assert.deepEqual(
    await call(
      owner,
      "POST",
      "/quickbooks/vendor-bills/b1/documents",
      claimBody,
    ),
    original,
  );
  await call(
    owner2,
    "POST",
    "/quickbooks/vendor-bills/b1/documents",
    { ...claimBody, requestKey: randomUUID() },
    400,
  );
  await call(
    owner,
    "POST",
    "/quickbooks/vendor-bills/b2/documents",
    { ...claimBody, requestKey: randomUUID() },
    400,
  );
  const download = await http(owner, "GET", original.downloadUrl.slice(4));
  assert.equal(download.status, 200);
  assert.match(download.headers["content-disposition"], /^attachment;/);
  assert.equal(download.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(download.body, pdf);
  await call(other, "GET", original.downloadUrl.slice(4), undefined, 404);
  await call(
    owner,
    "GET",
    "/storage" + uploaded.body.objectPath,
    undefined,
    404,
  );
  checks.push(
    "original PDF private claim/hash/replay/forced attachment and tenant isolation",
  );
  const blobEntry = [...blobs.entries()].find(([key]) =>
    key.includes("coverage-a-private"),
  )!;
  const oldBytes = blobEntry[1].bytes;
  blobEntry[1].bytes = Buffer.from("%PDF-1.4\nreplaced\n%%EOF\n");
  await call(owner, "GET", original.downloadUrl.slice(4), undefined, 409);
  blobEntry[1].bytes = oldBytes;
  checks.push("replaced original bytes cannot be downloaded under old claim");
  const suspendedChoice = coverageChoice([allocation("r2", "b3", "1")]);
  // Owner revocation after a legitimate preview is tested on the second tenant,
  // which still has capacity. The actual service must recheck current DB role.
  const beforeDemote = await call(
    other,
    "POST",
    "/quickbooks/receipt-coverage/preview",
    suspendedChoice,
  );
  await context(1, () =>
    db
      .update(usersTable)
      .set({ role: "sales" })
      .where(eq(usersTable.id, "owner")),
  );
  await call(
    other,
    "POST",
    "/quickbooks/receipt-coverage/approve",
    {
      choice: suspendedChoice,
      fingerprint: beforeDemote.fingerprint,
      requestKey: randomUUID(),
      confirmQuantities: true,
      confirmPriceVariances: true,
      confirmSourceIdentities: true,
    },
    403,
  );
  checks.push(
    "stale authenticated owner session cannot approve after demotion",
  );
  const waitingOwner = await login(1, "owner2"),
    waitingPreview = await call(
      waitingOwner,
      "POST",
      "/quickbooks/receipt-coverage/preview",
      suspendedChoice,
    );
  const waitingBody = {
    choice: suspendedChoice,
    fingerprint: waitingPreview.fingerprint,
    requestKey: randomUUID(),
    confirmQuantities: true,
    confirmPriceVariances: true,
    confirmSourceIdentities: true,
  };
  await context(1, async () => {
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM purchase_receipt_lines WHERE id='r2' FOR UPDATE",
      );
      const pending = http(
        waitingOwner,
        "POST",
        "/quickbooks/receipt-coverage/approve",
      )
        .send(waitingBody)
        .then((response: any) => response);
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const observed = await pool.query(
          "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE $1",
          ["%purchase_receipt_lines%"],
        );
        if (Number(observed.rows[0].n)) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        blocked,
        true,
        "actual approval must wait on the accepted receipt row",
      );
      await db
        .update(usersTable)
        .set({ role: "sales" })
        .where(eq(usersTable.id, "owner2"));
      await blocker.query("COMMIT");
      const response = await pending;
      assert.equal(response.status, 403);
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM vendor_bill_coverage_approvals",
            )
          ).rows[0].n,
        ),
        0,
      );
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
  checks.push(
    "owner demoted during an observed real receipt-lock wait cannot commit coverage",
  );
  await context(0, async () => {
    await db.insert(quickbooksConnectionsTable).values({
      id: "connection",
      realmId: "123",
      environment: "sandbox",
      companyName: "Synthetic US company",
      encryptedAccessToken: encryptSecret("synthetic-access"),
      encryptedRefreshToken: encryptSecret("synthetic-refresh"),
      accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      createdAt: "2026-11-23",
      updatedAt: "2026-11-23",
    });
    for (const [entityType, localId, quickbooksId] of [
      ["item", "product", "2"],
      ["customer", "job", "3"],
      ["invoice", "invoice", "4"],
    ])
      await db.insert(quickbooksEntityMappingsTable).values({
        id: randomUUID(),
        entityType,
        localId,
        quickbooksId,
        realmId: "123",
        environment: "sandbox",
        createdAt: "2026-11-23",
        updatedAt: "2026-11-23",
      });
    for (const [id, qty, number, posted] of [
      ["pb1", "6", "000081", "101"],
      ["pb2", "14", "000082", "102"],
    ])
      await pool.query(
        "INSERT INTO quickbooks_sync_jobs(id,idempotency_key,entity_type,local_id,action,status,payload,created_at,updated_at) VALUES($1,$1,'vendor_bill',$1,'create','completed',$2,'2026-11-23','2026-11-23')",
        [id, billSource(qty, number, posted)],
      );
  });
  remoteInvoices.set("4", {
    Id: "4",
    DocNumber: "INV-0001",
    CustomerRef: { value: "3" },
    TxnDate: "2026-11-23",
    CurrencyRef: { value: "USD" },
    Line: [
      {
        Id: "remote-line",
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: { ItemRef: { value: "2" }, Qty: 15, UnitPrice: 6 },
      },
    ],
    LinkedTxn: [],
  });
  const base = local.saved.allocations;
  await context(0, () =>
    pool.query(
      "INSERT INTO supplier_buy_prices(id,alias_id,unit,unit_cost,effective_on,source,approved_by,approved_at) VALUES('later-backdated-price','alias','sqft',4.99,'2026-11-22','Later backdated supplier agreement','owner','2026-11-24')",
    ),
  );
  await context(0, () =>
    pool.query(
      "INSERT INTO quickbooks_sync_jobs(id,idempotency_key,entity_type,local_id,action,status,payload,created_at,updated_at) SELECT 'pb-duplicate','pb-duplicate',entity_type,'pb-duplicate',action,status,payload,created_at,updated_at FROM quickbooks_sync_jobs WHERE id='pb1'",
    ),
  );
  const originalBase = base.find((row: any) => row.billId === "b1");
  await call(
    owner,
    "POST",
    "/quickbooks/receipt-coverage/preview",
    coverageChoice([
      allocation("r1", "pb1", "1", originalBase.id),
      allocation("r1", "pb-duplicate", "1", originalBase.id),
    ]),
    409,
  );
  const endorsed = await approve(
    owner,
    coverageChoice(
      base.map((row: any) =>
        allocation(
          row.receiptLineId,
          row.billId === "b1" ? "pb1" : "pb2",
          row.quantity,
          row.id,
        ),
      ),
    ),
  );
  assert.equal(endorsed.saved.allocations.length, 0);
  assert.equal(endorsed.preview.hasHistoricalIdentities, false);
  const coverage = await call(
    owner,
    "GET",
    "/quickbooks/receipt-coverage/options?billId=pb1",
  );
  assert.ok(
    coverage.allocations.every(
      (row: any) => row.providerBoundQuantity === row.quantity,
    ),
  );
  checks.push(
    "verified company endorsement appends original local evidence without consuming physical quantity twice",
  );
  checks.push(
    "later-approved backdated supplier prices never replace the exact frozen price date and cost on retained bills",
  );
  for (const [column, changed, original] of [
    ["unit_cost", "4.47", "4.46"],
    ["stock_units_per_buy_unit", "2", "1"],
    ["effective_on", "2025-12-31", "2026-01-01"],
  ]) {
    assert.ok(
      ["unit_cost", "stock_units_per_buy_unit", "effective_on"].includes(
        column,
      ),
    );
    await context(0, () =>
      pool.query(
        `UPDATE supplier_buy_prices SET ${column}=$1 WHERE id='price'`,
        [changed],
      ),
    );
    await call(
      owner,
      "GET",
      "/quickbooks/receipt-coverage/options?billId=pb1",
      undefined,
      409,
    );
    await context(0, () =>
      pool.query(
        `UPDATE supplier_buy_prices SET ${column}=$1 WHERE id='price'`,
        [original],
      ),
    );
  }
  checks.push(
    "a changed original price row, unit conversion factor or exact effective date still refuses coverage rather than silently repricing history",
  );
  await call(
    owner,
    "GET",
    "/quickbooks/receipt-coverage/options?billId=pb-duplicate",
    undefined,
    409,
  );
  checks.push(
    "one actual provider bill retains one immutable queue source; reordered duplicate copies cannot reopen line capacity",
  );
  await context(0, () =>
    pool.query(
      "UPDATE purchase_orders SET revision=revision+1,status='Received',updated_at='2026-11-24' WHERE id='po1'",
    ),
  );
  for (const bill of remoteBills.values()) {
    bill.SyncToken = "8";
    bill.LinkedTxn = [{ TxnId: "999", TxnType: "BillPaymentCheck" }];
  }
  const choice = {
    ...manualChoice,
    note: "Owner reviewed complete multi receipt and repeated return scope",
  };
  const preview = await call(
    owner,
    "POST",
    "/quickbooks/inventory-accounting-cases/preview",
    choice,
  );
  assert.equal(
    preview.plan.kind,
    "ready_quantity_plan",
    JSON.stringify(preview.plan),
  );
  assert.equal(preview.plan.quantityDifference, "3.000000");
  assert.equal(preview.plan.providerSubmissionAllowed, false);
  checks.push(
    "multiple purchase receipts/bills/returns remain reviewable after normal later PO/payment lifecycle changes",
  );
  const caseBody = {
    choice,
    fingerprint: preview.fingerprint,
    requestKey: randomUUID(),
    confirmNoFinancialPosting: true,
  };
  let releaseProvider!: () => void, enteredProvider!: () => void;
  const enteredProviderRead = new Promise<void>((resolve) => {
    enteredProvider = resolve;
  });
  providerGate = {
    entered: enteredProvider,
    wait: new Promise<void>((resolve) => {
      releaseProvider = resolve;
    }),
  };
  const pendingCase = http(
    owner,
    "POST",
    "/quickbooks/inventory-accounting-cases",
  )
    .send(caseBody)
    .then((response: any) => response);
  await enteredProviderRead;
  await context(0, async () => {
    const probe = await pool.connect();
    try {
      for (const query of [
        "SELECT id FROM jobs WHERE id='job' FOR UPDATE NOWAIT",
        "SELECT id FROM invoices WHERE id='invoice' FOR UPDATE NOWAIT",
        "LOCK TABLE quickbooks_entity_mappings IN ROW EXCLUSIVE MODE NOWAIT",
      ]) {
        await probe.query("BEGIN");
        await assert.rejects(
          probe.query(query),
          (error: any) => error.code === "55P03",
        );
        await probe.query("ROLLBACK");
      }
    } finally {
      await probe.query("ROLLBACK");
      probe.release();
      releaseProvider();
    }
  });
  const caseResponse = await pendingCase;
  assert.equal(caseResponse.status, 201, JSON.stringify(caseResponse.body));
  const savedCase = caseResponse.body;
  checks.push(
    "job, invoice and mapping insertion/retarget scope stays locked throughout actual provider-read waits",
  );
  assert.equal(savedCase.case.kind, "return_quantity_plan");
  assert.equal(
    (
      await call(
        owner,
        "POST",
        "/quickbooks/inventory-accounting-cases",
        caseBody,
      )
    ).replayed,
    true,
  );
  checks.push(
    "exact multi-return quantity plan is durable and idempotent without provider submission",
  );
  const later = await call(
    owner,
    "POST",
    "/quickbooks/inventory-accounting-cases/preview",
    choice,
  );
  assert.equal(later.plan.kind, "manual_review");
  assert.ok(later.plan.reasonCodes.includes("prior_claim_unresolved"));
  checks.push(
    "pending accounting case reserves returns and prevents duplicate quantity plans",
  );
  const oldChoice = {
    productId: "product",
    returnId: "return1",
    invoiceId: "invoice",
    billId: "pb1",
    accountId: "5",
    date: "2026-11-23",
    connectionId: "connection",
  };
  const oldApproval = {
    choice: oldChoice,
    fingerprint: "f".repeat(64),
    requestId: "cwadj-" + "a".repeat(44),
    before: 15,
    target: 17,
    document: {
      DocNumber: "CWAR" + "a".repeat(16),
      TxnDate: "2026-11-23",
      PrivateNote: "Synthetic original legacy reference",
      AdjustAccountRef: { value: "5" },
      Line: [
        {
          DetailType: "ItemAdjustmentLineDetail",
          ItemAdjustmentLineDetail: { ItemRef: { value: "2" }, QtyDiff: 2 },
        },
      ],
    },
    submitted: true,
  };
  await context(0, () =>
    pool.query(
      "INSERT INTO quickbooks_sync_jobs(id,idempotency_key,entity_type,local_id,action,status,payload,created_at,updated_at) VALUES('legacy-guard','stock-return:sandbox:123:return1','stock_return_adjustment','return1','create','completed',$1,'2026-11-23','2026-11-23')",
      [oldApproval],
    ),
  );
  await call(
    owner,
    "POST",
    "/quickbooks/stock-reconciliation/approve",
    { choice: oldChoice, fingerprint: oldApproval.fingerprint },
    409,
  );
  await context(0, () =>
    pool.query("DELETE FROM quickbooks_sync_jobs WHERE id='legacy-guard'"),
  );
  checks.push(
    "old automatic return endpoint refuses a return reserved by the new accounting case before any provider write",
  );
  adjustments.set("900", {
    Id: "900",
    DocNumber: savedCase.case.reference,
    TxnDate: "2026-11-23",
    Line: [
      {
        DetailType: "ItemAdjustmentLineDetail",
        ItemAdjustmentLineDetail: { ItemRef: { value: "2" }, QtyDiff: 3 },
      },
    ],
  });
  quantityOnHand = -0.000001;
  const actualAdjustment = adjustments.get("900");
  for (const change of [
    { DocNumber: "Wrong-case-reference" },
    { TxnDate: "2026-11-22" },
    { TxnDate: "2099-01-01" },
    {
      Line: [
        {
          DetailType: "ItemAdjustmentLineDetail",
          ItemAdjustmentLineDetail: { ItemRef: { value: "9" }, QtyDiff: 3 },
        },
      ],
    },
    {
      Line: [
        {
          DetailType: "ItemAdjustmentLineDetail",
          ItemAdjustmentLineDetail: { ItemRef: { value: "2" }, QtyDiff: 2 },
        },
      ],
    },
  ]) {
    adjustments.set("900", { ...actualAdjustment, ...change });
    await call(
      owner,
      "POST",
      `/quickbooks/inventory-accounting-cases/${savedCase.case.id}/verify-adjustment`,
      {
        requestKey: randomUUID(),
        note: "Explicit negative original document evidence check",
        adjustmentId: "900",
      },
      409,
    );
  }
  adjustments.set("900", actualAdjustment);
  checks.push(
    "wrong reference, old/future date, wrong item and wrong quantity cannot confirm an external document",
  );
  await context(0, () =>
    pool.query(
      "UPDATE jobs SET notes='Benign later job note',status='Completed',updated_at='2026-11-24' WHERE id='job'",
    ),
  );
  await context(0, async () => {
    await pool.query(
      "INSERT INTO warehouses(id,name,created_at,updated_at) VALUES('warehouse2','Fictional remote','2026-11-23','2026-11-23')",
    );
    await pool.query(
      "INSERT INTO inventory_transfers(id,product_id,source_warehouse_id,destination_warehouse_id,quantity,reason,status,idempotency_key,dispatched_by,created_at,updated_at) VALUES('later-transit','product','warehouse','warehouse2',0.000001,'Synthetic later transfer','In transit','later-transit','owner','2026-11-23','2026-11-23')",
    );
    await pool.query(
      "UPDATE products SET quantity_on_hand=1.000001 WHERE id='product'",
    );
    await pool.query(
      "INSERT INTO inventory_movements(id,product_id,warehouse_id,quantity,kind,reason,idempotency_key,created_at) VALUES('later-stock','product','warehouse',-16.999998,'adjustment','Synthetic later unrelated stock activity','later-stock','2026-11-23T20:00:00Z')",
    );
  });
  await context(0, () =>
    db
      .update(quickbooksConnectionsTable)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 10000).toISOString() })
      .where(eq(quickbooksConnectionsTable.id, "connection")),
  );
  one401 = true;
  const eventBody = {
    requestKey: randomUUID(),
    note: "Owner verified exact external adjustment source and balance",
    adjustmentId: "900",
  };
  const verified = await call(
    owner,
    "POST",
    `/quickbooks/inventory-accounting-cases/${savedCase.case.id}/verify-adjustment`,
    eventBody,
  );
  const verifiedEvent = verified.events.find(
    (event: any) => event.kind === "external_adjustment_verified",
  );
  assert.equal(
    verified.events.filter(
      (event: any) => event.kind === "external_adjustment_verified",
    ).length,
    1,
  );
  assert.ok(refreshCalls >= 2);
  assert.deepEqual(
    await call(
      owner,
      "POST",
      `/quickbooks/inventory-accounting-cases/${savedCase.case.id}/verify-adjustment`,
      eventBody,
    ),
    verified,
  );
  checks.push(
    "expired token and provider401 refresh complete without connection SHARE self-deadlock",
  );
  assert.equal(verifiedEvent.balanceObservation.worksQuantity, "1.000002");
  assert.equal(
    verifiedEvent.balanceObservation.quickBooksQuantity,
    "-0.000001",
  );
  assert.equal(verifiedEvent.balanceObservation.matchesCurrentWorks, false);
  assert.equal(verifiedEvent.balanceObservation.matchesSavedTarget, false);
  checks.push(
    "historical document can be confirmed after later stock changes; exact fractional transit and changed current balances are independently reported",
  );
  const note = {
    requestKey: randomUUID(),
    note: "Owner appended a durable accountant reconciliation note",
  };
  const noted = await call(
    owner2,
    "POST",
    `/quickbooks/inventory-accounting-cases/${savedCase.case.id}/notes`,
    note,
  );
  assert.equal(noted.events.length, 2);
  checks.push("owner append-only case notes preserve verified outcome");
  await context(0, async () => {
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) n FROM vendor_bill_receipt_allocations",
          )
        ).rows[0].n,
      ),
      3,
    );
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) n FROM vendor_bill_coverage_bindings",
          )
        ).rows[0].n,
      ),
      3,
    );
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT quantity_on_hand n FROM products WHERE id='product'",
          )
        ).rows[0].n,
      ),
      1.000001,
    );
  });
  checks.push(
    "coverage/cases do not change stock, receive twice or issue financial provider writes",
  );
  assert.equal(unexpectedCalls, 0);
  assert.equal(financialProviderPosts, 0);
  console.log(
    JSON.stringify({
      billCoverage: "passed",
      checks,
      unexpectedCalls,
      financialProviderPosts,
      refreshCalls,
      tenantDatabases: 2,
      providerTransport: "synthetic",
      actualPostgres: true,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  await closeWorkspaceConnections();
}
