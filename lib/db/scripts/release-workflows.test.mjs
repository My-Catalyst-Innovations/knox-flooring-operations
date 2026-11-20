import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import pg from "pg";
import { loadMigrations, loadExpectedColumns, loadExpectedForeignKeys, runMigrations, MIGRATION_LOCK } from "./migration-runner.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const execute = promisify(execFile);
const migrations = await loadMigrations();
const migrationOptions = { migrations, expectedColumns: await loadExpectedColumns(), expectedForeignKeys: await loadExpectedForeignKeys() };
const baselineSchema = JSON.parse(await readFile(new URL("../migrations/meta/0000_snapshot.json", import.meta.url), "utf8"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata)$/i.test(key)));

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function connect(connectionString) { const client = new pg.Client({ connectionString }); await client.connect(); return client; }
async function snapshot(client) {
  const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const data = {};
  for (const { tablename } of rows) {
    assert.match(tablename, /^[a-z_]+$/);
    data[tablename] = (await client.query(`SELECT * FROM "${tablename}" AS row ORDER BY to_jsonb(row)::text`)).rows;
  }
  return data;
}
async function legacySnapshot(client) {
  const data = {};
  for (const table of ["jobs", "invoices", "products", "proposals", "leads"]) {
    const columns = Object.keys(baselineSchema.tables[`public.${table}`].columns).map(column => `"${column}"`).join(",");
    data[table] = (await client.query(`SELECT ${columns} FROM ${table} ORDER BY id`)).rows;
  }
  return data;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(5000)]);
}

test("real PostgreSQL migration, HTTP workflows, concurrency and backup recovery", { timeout: 180000 }, async t => {
  assert.ok(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL is required; use a disposable local PostgreSQL server.");
  assert.ok(process.env.PG_BIN, "PG_BIN is required so the backup is actually restored and verified.");
  const source = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(source.hostname), "Release tests refuse non-loopback databases.");
  const suffix = `${Date.now()}_${randomUUID().slice(0, 8)}`;
  const names = [`catalyst_release_${suffix}`, `catalyst_restore_${suffix}`];
  const connections = names.map(name => { const url = new URL(source); url.pathname = `/${name}`; return url.toString(); });
  const admin = await connect(source.toString());
  const temporary = await mkdtemp(path.join(tmpdir(), "catalyst-release-"));
  let database, restored, server, logs = "";
  const executable = name => path.join(process.env.PG_BIN, name + (process.platform === "win32" ? ".exe" : ""));
  const pgEnvironment = databaseName => ({ ...safeEnvironment, PGHOST: source.hostname, PGPORT: source.port || "5432", PGUSER: decodeURIComponent(source.username), PGPASSWORD: decodeURIComponent(source.password), PGDATABASE: databaseName, PGSSLMODE: "disable" });
  const run = async (name, fn) => { let failure; await t.test(name, async () => { try { await fn(); } catch (error) { failure = error; throw error; } }); if (failure) throw failure; };
  try {
    for (const name of names) { assert.match(name, /^catalyst_(release|restore)_\d+_[a-f0-9]+$/); await admin.query(`CREATE DATABASE "${name}"`); }
    database = await connect(connections[0]);
    await database.query(migrations[0].sql);
    await database.query("INSERT INTO jobs (id,job_number,customer_name,address,city,flooring_type,material_status,priority_level,risk_level,status,est_start_date,share_token,est_revenue,created_at,updated_at) VALUES ('legacy-job','J-100','Same name','100 Test Way','Knoxville','Tile','Ordered','Medium','Low','Scheduled','2020-01-02','preserve-share-token',900,'2019-01-01','2020-01-01'),('other-job','J-101','Same name','200 Test Way','Knoxville','Tile','Ordered','Medium','Low','Approved',null,'preserve-other-token',200,'2019-01-01','2020-01-01')");
    await database.query("INSERT INTO invoices (id,invoice_number,job_id,customer_name,total,paid_amount,balance_amount,status,created_at,updated_at) VALUES ('legacy-invoice','I-100','legacy-job','Same name',900,300,600,'Partial','2019-01-01','2020-01-01')");
    await database.query("INSERT INTO products (id,name,category,unit,cost,price,quantity_on_hand,created_at,updated_at) VALUES ('area-product','Fixture flooring','Tile','sqft',2,4,215.25,'2019-01-01','2020-01-01'),('box-product','Fixture boxes','Tile','box',10,20,12.5,'2019-01-01','2020-01-01')");
    await database.query("INSERT INTO proposals (id,job_id,customer_name,flooring_type,status,estimated_price,share_token,created_at) VALUES ('legacy-proposal','legacy-job','Original recipient','Tile','Sent',900,'proposal-token','2019-01-01')");
    const before = await legacySnapshot(database);
    await run("pg_dump restores the baseline exactly before migration", async () => {
      const backup = path.join(temporary, "baseline.dump");
      await execute(executable("pg_dump"), ["--format=custom", "--no-owner", "--no-acl", `--file=${backup}`], { env: pgEnvironment(names[0]), windowsHide: true });
      await execute(executable("pg_restore"), ["--exit-on-error", "--no-owner", "--no-acl", `--dbname=${names[1]}`, backup], { env: pgEnvironment(names[1]), windowsHide: true });
      restored = await connect(connections[1]);
      assert.deepEqual(await snapshot(restored), await snapshot(database));
      t.diagnostic(`Baseline backup verified: SHA-256 ${createHash("sha256").update(await readFile(backup)).digest("hex")}`);
    });
    await run("both original and restored databases adopt additive migrations without data changes", async () => {
      await runMigrations(database, migrationOptions); await runMigrations(restored, migrationOptions);
      assert.deepEqual(await legacySnapshot(database), before); assert.deepEqual(await legacySnapshot(restored), before);
      assert.equal((await database.query("SELECT count(*)::int AS n FROM customers")).rows[0].n, 2);
      assert.equal((await database.query("SELECT customer_id FROM proposals WHERE id='legacy-proposal'")).rows[0].customer_id, "legacy:job:legacy-job");
      assert.equal((await database.query("SELECT sold_at FROM jobs WHERE id='legacy-job'")).rows[0].sold_at, null);
      assert.deepEqual((await runMigrations(database, migrationOptions)).applied, []);
    });
    await run("two PostgreSQL sessions cannot migrate concurrently", async () => {
      const competitor = await connect(connections[0]);
      try { await database.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]); await assert.rejects(runMigrations(competitor, migrationOptions), /Another release/); }
      finally { await database.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]); await competitor.end(); }
    });
    const port = await unusedPort(); const base = `http://127.0.0.1:${port}/api`; const password = `Release-${randomUUID()}`;
    const testAdapter = process.env.CATALYST_ISOLATED_TEST === "true";
    const apiEnvironment = { ...safeEnvironment, ...(testAdapter ? { CATALYST_ISOLATED_TEST: "true" } : {}), DATABASE_URL: connections[0], HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "test", APP_BASE_URL: `http://127.0.0.1:${port}`, BACKGROUND_WORKERS_ENABLED: "false", DEMO_MODE: "true", DEMO_ACCESS_ENABLED: "false", OWNER_EMAIL: "owner@release.test", OWNER_NAME: "Release test owner", OWNER_INITIAL_PASSWORD: password, LOG_LEVEL: "silent" };
    server = spawn(process.execPath, [path.join(root, `artifacts/api-server/${testAdapter ? "dist-test" : "dist"}/index.mjs`)], { cwd: root, windowsHide: true, env: apiEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", data => { logs = (logs + data).slice(-16000); }); server.stderr.on("data", data => { logs = (logs + data).slice(-16000); });
    await run("API startup is ready without seeding or rewriting historical schedules", async () => {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) { try { ready = (await fetch(`${base}/healthz`)).ok; } catch {} if (ready) break; if (server.exitCode !== null) break; await sleep(100); }
      assert.ok(ready, `API did not become ready: ${logs}`); assert.deepEqual(await legacySnapshot(database), before);
      assert.equal((await database.query("SELECT count(*)::int AS n FROM settings")).rows[0].n, 0);
    });
    async function request(session, route, method = "GET", data, expected = 200, instance = base) {
      const response = await fetch(instance + route, { method, headers: { "Content-Type": "application/json", ...(session ? { Cookie: session.cookie, "x-csrf-token": session.csrf } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const body = response.status === 204 ? null : await response.json();
      assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(body)}`); return body;
    }
    async function login(email, accountPassword = password) {
      const response = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: accountPassword }) });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
      return { cookie: response.headers.get("set-cookie").split(";")[0], csrf: body.csrfToken };
    }
    const owner = await login("owner@release.test");
    for (const role of ["sales", "operations", "installer"]) await database.query("INSERT INTO users (id,email,password_hash,name,role,created_at,updated_at) SELECT $1,$2,password_hash,$1,$1,created_at,updated_at FROM users WHERE email='owner@release.test'", [role, `${role}@release.test`]);
    const sales = await login("sales@release.test"), operations = await login("operations@release.test"), installer = await login("installer@release.test");
    await run("actual role sessions and CSRF enforce API permissions", async () => {
      await request(null, "/customers", "GET", undefined, 401);
      await request(sales, "/customers"); await request(sales, "/inventory/reservations", "POST", {}, 403);
      await request(sales, "/products", "POST", {}, 403);
      await request(sales, "/products/area-product", "PATCH", { price: 1 }, 403);
      await request(sales, "/products/area-product", "DELETE", undefined, 403);
      await request(operations, "/crews"); await request(operations, "/customers", "GET", undefined, 403);
      await request(installer, "/jobs"); await request(installer, "/bookings", "GET", undefined, 403);
      await request(installer, "/jobs/legacy-job", "PATCH", { actualRevenue: 1 }, 403);
      await request({ ...owner, csrf: "incorrect" }, "/customers", "POST", { name: "Blocked" }, 403);
      await request(owner, "/auth/persona", "POST", { role: "sales" });
      await request(owner, "/customers/legacy%3Ajob%3Alegacy-job/merge", "POST", { targetId: "legacy:job:other-job", revision: 1 }, 403);
      await request(owner, "/auth/persona", "POST", { role: null });
    });
    await run("named staff invitations expire, redeem once, enforce roles, and revoke sessions", async () => {
      const staff = "/auth/staff";
      const person = { name: "Release warehouse teammate", email: "Invite-Ops@Release.Test", role: "operations" };
      const passwordForInvite = `Invite-${randomUUID()}`;
      await request(null, staff, "GET", undefined, 401);
      await request(sales, staff, "GET", undefined, 403);
      await request(operations, `${staff}/invitations`, "POST", person, 403);
      await request({ ...owner, csrf: "incorrect" }, `${staff}/invitations`, "POST", person, 403);
      const currentOwner = (await request(owner, "/auth/session")).user;
      await request(owner, `${staff}/${currentOwner.userId}/deactivate`, "POST", undefined, 409);
      await request(owner, "/auth/persona", "POST", { role: "operations" });
      await request(owner, `${staff}/invitations`, "POST", person, 403);
      await request(owner, "/auth/persona", "POST", { role: null });

      const first = await request(owner, `${staff}/invitations`, "POST", person, 201);
      assert.equal(first.staff.email, "invite-ops@release.test");
      assert.equal(first.staff.active, false);
      assert.equal(first.staff.invitationPending, true);
      assert.ok(Date.parse(first.expiresAt) > Date.now());
      await request(null, "/auth/login", "POST", { email: first.staff.email, password: passwordForInvite }, 401);
      await request(null, "/auth/password/reset", "POST", { token: first.token, password: passwordForInvite }, 400);
      await request(owner, `${staff}/invitations`, "POST", { ...person, email: first.staff.email }, 409);
      const stored = (await database.query("SELECT token_hash FROM password_reset_tokens WHERE user_id=$1", [first.staff.id])).rows[0].token_hash;
      assert.equal(stored, `staff:${createHash("sha256").update(first.token).digest("hex")}`);
      await database.query("UPDATE password_reset_tokens SET expires_at=$1 WHERE user_id=$2", ["2000-01-01T00:00:00.000Z", first.staff.id]);
      await request(null, `${staff}/accept`, "POST", { token: first.token, password: passwordForInvite }, 400);

      const replacement = await request(owner, `${staff}/${first.staff.id}/invitation`, "POST", undefined, 201);
      const renewed = await request(owner, `${staff}/${first.staff.id}/invitation`, "POST", undefined, 201);
      assert.notEqual(replacement.token, renewed.token);
      await request(null, `${staff}/accept`, "POST", { token: replacement.token, password: passwordForInvite }, 400);
      const accept = () => fetch(`${base}${staff}/accept`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: renewed.token, password: passwordForInvite }),
      });
      const results = await Promise.all([accept(), accept()]);
      assert.deepEqual(results.map(({ status }) => status).sort(), [204, 400]);
      const namedOps = await login(first.staff.email, passwordForInvite);
      const signedIn = (await request(namedOps, "/auth/session")).user;
      assert.equal(signedIn.userId, first.staff.id);
      assert.equal(signedIn.role, "operations");
      await request(namedOps, "/inventory/warehouses");
      await request(namedOps, staff, "GET", undefined, 403);
      const listed = (await request(owner, staff)).find(member => member.id === first.staff.id);
      assert.equal(listed.active, true);
      assert.equal(listed.invitationPending, false);
      assert.equal("passwordHash" in listed || "token" in listed, false);

      const secondOwner = await request(owner, `${staff}/invitations`, "POST", { name: "Release second owner", email: "second-owner@release.test", role: "owner" }, 201);
      await request(null, `${staff}/accept`, "POST", { token: secondOwner.token, password: passwordForInvite }, 204);
      const namedOwner = await login(secondOwner.staff.email, passwordForInvite);
      assert.equal((await request(namedOwner, "/auth/session")).user.role, "owner");
      await request(namedOwner, staff);
      await request(namedOwner, `${staff}/${secondOwner.staff.id}/deactivate`, "POST", undefined, 409);
      await request(owner, `${staff}/${first.staff.id}/deactivate`, "POST");
      await request(namedOps, "/auth/session", "GET", undefined, 401);
      await request(null, "/auth/login", "POST", { email: first.staff.email, password: passwordForInvite }, 401);
      await request(owner, `${staff}/${secondOwner.staff.id}/deactivate`, "POST");
      await request(namedOwner, "/auth/session", "GET", undefined, 401);
      await request(owner, `${staff}/${currentOwner.userId}/deactivate`, "POST", undefined, 409);
    });
    let customer, draft, jobId;
    await run("customer creation, locations and stale edits preserve distinct identities", async () => {
      customer = await request(sales, "/customers", "POST", { name: "Estimate customer", email: "estimate@release.test" }, 201);
      const duplicate = await request(sales, "/customers", "POST", { name: "Estimate customer" }, 201); assert.notEqual(customer.id, duplicate.id);
      const site = await request(sales, `/customers/${customer.id}/sites`, "POST", { label: "Main site", address: "123 Fixture Road", city: "Knoxville" }, 201); assert.equal(site.customerId, customer.id);
      const changed = await request(sales, `/customers/${customer.id}`, "PATCH", { revision: customer.revision, phone: "555-0100" });
      await request(sales, `/customers/${customer.id}`, "PATCH", { revision: customer.revision, phone: "stale" }, 409); customer = changed;
      const unknown = await request(owner, "/metrics?from=2020-01-01&to=2020-02-01");
      assert.equal(unknown.soldRevenue, 0); assert.equal(unknown.jobsSold, 0); assert.equal(unknown.capacityHours, null); assert.equal(unknown.scheduledUtilization, null); assert.ok(unknown.missingSoldDates >= 2);
    });
    await run("draft save/reload and concurrent conversion produce one exact priced job", async () => {
      const inputs = { customerName: customer.name, customerId: customer.id, city: "Knoxville", flooringType: "Tile", rooms: [{ id: "room-1", name: "Room", length: 10, width: 10 }], wastePercent: 10, laborRate: 5, laborOverrideReason: "Reviewed release fixture rate", targetMarginPercent: 25, lines: [{ productId: "area-product", name: "Fixture flooring", sku: "", unit: "sqft", cost: 2, price: 4, coveragePerUnit: 1, orderMultiple: 1, minimumOrderQty: 0 }], allowances: [{ id: "prep", name: "Prep", cost: 30 }], notes: "Synthetic test", policyVersion: 1, productivitySqFtPerHour: 25 };
      const id = randomUUID(); draft = await request(sales, "/estimate-drafts", "POST", { id, title: "Reviewed test estimate", inputs }, 201);
      assert.equal(draft.snapshot.valid, true); assert.equal(draft.snapshot.totalCost, 750); assert.equal(draft.snapshot.sellingPrice, 1000); assert.equal(draft.snapshot.lines[0].quantity, 110);
      assert.deepEqual((await request(sales, `/estimate-drafts/${id}`)).snapshot, draft.snapshot);
      const conversions = await Promise.all([request(sales, `/estimate-drafts/${id}/convert`, "POST", { revision: draft.revision, target: "job" }), request(sales, `/estimate-drafts/${id}/convert`, "POST", { revision: draft.revision, target: "job" })]);
      jobId = conversions[0].jobId; assert.equal(jobId, conversions[1].jobId);
      const job = await request(sales, `/jobs/${jobId}`); assert.equal(job.estRevenue, 1000); assert.equal(job.laborEstimate, 500); assert.equal(job.materialEstimate, 250); assert.equal(job.estLaborHours, 4);
      await request(sales, `/estimate-drafts/${id}/convert`, "POST", { revision: draft.revision, target: "proposal" }, 409);
    });
    await run("concurrent accepted-quote conversion preserves total and does not invent a paid deposit", async () => {
      const quoteInputs = { ...draft.inputs, lines: draft.inputs.lines.map((line) => ({ ...line, sku: "FIXTURE-AREA" })) };
      const quoteDraft = await request(sales, "/estimate-drafts", "POST", { title: "Quote path", inputs: quoteInputs }, 201);
      const converted = await request(sales, `/estimate-drafts/${quoteDraft.id}/convert`, "POST", { revision: quoteDraft.revision, target: "proposal" });
      const quote = (await request(sales, "/proposals")).find(row => row.id === converted.proposalId);
      assert.equal(quote.lineItems.reduce((cents, line) => cents + Math.round(line.lineTotal * 100), 0), 100000);
      const publicQuote = await request(null, `/public/quotes/${quote.shareToken}`);
      assert.equal(publicQuote.lineItems.reduce((cents, line) => cents + Math.round(line.lineTotal * 100), 0), Math.round(publicQuote.estimatedPrice * 100));
      assert.equal("estimateSnapshot" in publicQuote, false);
      assert.ok(publicQuote.lineItems.every(line => !("cost" in line) && !("productId" in line)));
      await request(sales, `/proposals/${converted.proposalId}`, "PATCH", { status: "Accepted", depositType: "percent", depositValue: 25 });
      const result = await Promise.all([request(sales, `/proposals/${converted.proposalId}/convert`, "POST", {}), request(sales, `/proposals/${converted.proposalId}/convert`, "POST", {})]);
      assert.equal(result[0].job.id, result[1].job.id); assert.equal(result[0].invoice.id, result[1].invoice.id);
      assert.equal(result[0].invoice.total, 1000); assert.equal(result[0].invoice.paidAmount, 0); assert.equal(result[0].invoice.depositAmount, 0); assert.equal(result[0].invoice.balanceAmount, 1000);
      const { invoice } = result[0];
      assert.deepEqual(invoice.lineItems, result[1].invoice.lineItems);
      assert.deepEqual(invoice.lineItems.map((line) => line.description), quote.lineItems.map((line) => `${line.name} (${line.unit})`));
      assert.deepEqual(invoice.lineItems.map((line) => line.quantity), quote.lineItems.map((line) => line.quantity));
      assert.deepEqual(invoice.lineItems.map((line) => line.unitPrice), quote.lineItems.map((line) => line.unitPrice));
      assert.equal(invoice.lineItems[0].productId, "area-product");
      assert.equal(invoice.lineItems[0].sku, "FIXTURE-AREA");
      assert.equal(invoice.lineItems[1].productId, undefined);
      assert.equal(invoice.lineItems.reduce((cents, line) => cents + Math.round(line.quantity * line.unitPrice * 100), 0), 100000);
      const legacyEditLines = invoice.lineItems.map(({ productId, sku, ...line }) => line);
      const edited = await request(owner, `/invoices/${invoice.id}`, "PATCH", { lineItems: legacyEditLines, notes: "Reviewed invoice" });
      assert.deepEqual(edited.lineItems, invoice.lineItems);
      assert.equal(edited.total, 1000);
      assert.equal(edited.balanceAmount, 1000);
      assert.deepEqual((await request(owner, "/invoices")).find((row) => row.id === invoice.id).lineItems, invoice.lineItems);
    });
    await run("lead conversion is idempotent and retains contact/project facts", async () => {
      const lead = await request(sales, "/leads", "POST", { customerName: "Lead customer", phone: "555-0199", address: "1 Lead Way", city: "Knoxville", flooringInterest: "Tile", estimatedValue: 1200, estimatedSqft: 150, source: "Referral", stage: "New" }, 201);
      const result = await Promise.all([request(sales, `/leads/${lead.id}/convert`, "POST", { revision: lead.revision }), request(sales, `/leads/${lead.id}/convert`, "POST", { revision: lead.revision })]);
      assert.equal(result[0].id, result[1].id); assert.equal(result[0].phone, "555-0199"); assert.equal(result[0].address, "1 Lead Way"); assert.equal(result[0].estRevenue, 1200); assert.equal(result[0].actualRevenue, 0);
    });
    await run("public accept and decline cannot overwrite each other's terminal response", async () => {
      for (const firstAction of ["accept", "decline"]) {
        const id = randomUUID(), token = randomUUID();
        await database.query("INSERT INTO proposals (id,customer_id,customer_name,flooring_type,status,estimated_price,share_token,created_at) VALUES ($1,$2,'Concurrent response','Tile','Sent',1000,$3,'2026-10-23')", [id, customer.id, token]);
        const blocker = await connect(connections[0]); let first, second;
        const respond = action => fetch(`${base}/public/quotes/${token}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signature: "Reviewed Customer", revision: 1 }) });
        const waitForBlockedUpdates = async count => {
          let waiting = 0;
          for (let attempt = 0; attempt < 100; attempt++) {
            waiting = (await database.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%update%proposals%'")).rows[0].n;
            if (waiting >= count) break; await sleep(20);
          }
          assert.ok(waiting >= count, "Both response reads completed before their competing updates");
        };
        try {
          await blocker.query("BEGIN"); await blocker.query("SELECT id FROM proposals WHERE id=$1 FOR UPDATE", [id]);
          first = respond(firstAction); await waitForBlockedUpdates(1);
          second = respond(firstAction === "accept" ? "decline" : "accept"); await waitForBlockedUpdates(2);
          await blocker.query("COMMIT");
          assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [200, 409]);
          const saved = (await database.query("SELECT status,signature,accepted_at,declined_at,revision FROM proposals WHERE id=$1", [id])).rows[0];
          assert.equal(saved.status, firstAction === "accept" ? "Accepted" : "Declined"); assert.equal(saved.revision, 2);
          assert.equal(saved.signature, firstAction === "accept" ? "Reviewed Customer" : "");
          assert.equal(firstAction === "accept" ? saved.declined_at : saved.accepted_at, null);
        } finally { await blocker.query("ROLLBACK"); await blocker.end(); await Promise.allSettled([first, second].filter(Boolean)); }
      }
    });
    await run("public responses require the terms revision actually displayed to the customer", async () => {
      const source = await request(sales, "/estimate-drafts", "POST", { inputs: draft.inputs }, 201);
      const converted = await request(sales, `/estimate-drafts/${source.id}/convert`, "POST", { revision: source.revision, target: "proposal" });
      const sent = await request(sales, `/proposals/${converted.proposalId}`, "PATCH", { status: "Sent" });
      const viewed = await request(null, `/public/quotes/${sent.shareToken}`);
      await request(sales, `/proposals/${sent.id}`, "PATCH", { revision: viewed.revision, paymentTerms: "Updated terms require review" });
      await request(null, `/public/quotes/${sent.shareToken}/accept`, "POST", { signature: "Retained Customer", revision: viewed.revision }, 409);
      await request(null, `/public/quotes/${sent.shareToken}/decline`, "POST", { revision: viewed.revision }, 409);
      await request(null, `/public/quotes/${sent.shareToken}/accept`, "POST", { signature: "Missing reviewed revision" }, 400);
      const current = await request(null, `/public/quotes/${sent.shareToken}`);
      assert.equal(current.status, "Viewed"); assert.equal(current.signature, ""); assert.equal(current.paymentTerms, "Updated terms require review");
      const accepted = await request(null, `/public/quotes/${sent.shareToken}/accept`, "POST", { signature: "Retained Customer", revision: current.revision });
      assert.equal(accepted.status, "Accepted"); assert.equal(accepted.signature, "Retained Customer");
    });
    await run("accepted quotes reuse the linked job and create one invoice on retry", async () => {
      const linkedId = randomUUID(), quoteId = randomUUID();
      await database.query("INSERT INTO jobs (id,job_number,customer_id,customer_name,flooring_type,status,material_status,priority_level,risk_level,created_at,updated_at) VALUES ($1,'LINKED-100',$2,$3,'Tile','Estimate Completed','Not Ordered','Low','Low','2026-10-23','2026-10-23')", [linkedId, customer.id, customer.name]);
      await database.query("INSERT INTO proposals (id,job_id,customer_id,customer_name,flooring_type,status,estimated_price,share_token,created_at,accepted_at) VALUES ($1,$2,$3,$4,'Tile','Accepted',300,$5,'2026-10-23','2026-10-24')", [quoteId, linkedId, customer.id, customer.name, randomUUID()]);
      const results = await Promise.all([request(sales, `/proposals/${quoteId}/convert`, "POST", {}), request(sales, `/proposals/${quoteId}/convert`, "POST", {})]);
      assert.ok(results.every((result) => result.job.id === linkedId && result.job.status === "Approved" && result.invoice.jobId === linkedId));
      assert.equal(results[0].invoice.id, results[1].invoice.id);
      assert.equal((await database.query("SELECT count(*)::int AS n FROM invoices WHERE job_id=$1", [linkedId])).rows[0].n, 1);
    });
    await run("job updates retain the author, survive retries and stay internal", async () => {
      const path = `/jobs/${jobId}/updates`;
      const data = { id: randomUUID(), message: "Bring extra transition strips." };
      const posted = await request(installer, path, "POST", data, 201);
      assert.equal(posted.authorName, "installer");
      assert.deepEqual(await request(installer, path, "POST", data), posted);
      await request(operations, path, "POST", data, 409);
      assert.deepEqual(await request(owner, path), [posted]);
      await request(null, path, "GET", undefined, 401);
    });
    await run("a flooring job reconciles from customer quote through purchase, installation, and invoice", async () => {
      const customer = await request(sales, "/customers", "POST", {
        name: "Internal flooring workflow", email: "workflow@release.test",
      }, 201);
      const product = await request(operations, "/products", "POST", {
        name: "Workflow vinyl", sku: "WF-VINYL-01", category: "Vinyl Plank", unit: "box",
        cost: 27, price: 75, coveragePerUnit: 20, coverageUnit: "sqft",
      }, 201);
      const estimate = await request(sales, "/estimate-drafts", "POST", {
        title: "Internal flooring workflow",
        inputs: {
          ...draft.inputs, customerId: customer.id, customerName: customer.name, flooringType: "Luxury Vinyl Plank (LVP)",
          wastePercent: 0, allowances: [],
          lines: [{ productId: product.id, name: product.name, sku: product.sku, unit: "box", cost: 27,
            price: 75, coveragePerUnit: 20, orderMultiple: 1, minimumOrderQty: 0 }],
        },
      }, 201);
      assert.equal(estimate.snapshot.lines[0].quantity, 5);
      const proposal = await request(sales, `/estimate-drafts/${estimate.id}/convert`, "POST", { revision: estimate.revision, target: "proposal" });
      const sent = await request(sales, `/proposals/${proposal.proposalId}`, "PATCH", { status: "Sent" });
      const quotePath = `/public/quotes/${sent.shareToken}`;
      const quote = await request(null, quotePath);
      assert.ok(quote.lineItems.every((line) => !("cost" in line)));
      const email = { to: "workflow@release.test", subject: "Flooring proposal", body: `Your quote is available at ${base}${quotePath}`, idempotencyKey: randomUUID() };
      const capturedEmail = await request(owner, "/communications/email", "POST", email, 201);
      assert.equal(capturedEmail.status, "captured");
      assert.equal((await request(owner, "/communications/email", "POST", email)).id, capturedEmail.id);
      const accepted = await request(null, `${quotePath}/accept`, "POST", { signature: "Synthetic Flooring Customer", revision: quote.revision });
      assert.equal(accepted.status, "Accepted");
      const { job, invoice } = await request(sales, `/proposals/${sent.id}/convert`, "POST", {});
      const jobPath = `/jobs/${job.id}`;
      assert.equal(invoice.total, quote.estimatedPrice);
      assert.equal(invoice.balanceAmount, invoice.total);

      const warehouse = await request(operations, "/inventory/warehouses", "POST", { name: "Workflow receiving" }, 201);
      const bin = await request(operations, "/inventory/bins", "POST", { warehouseId: warehouse.id, code: "WF-A01" }, 201);
      await request(owner, "/inventory/supplier-crosswalk/approve", "POST", {
        effectiveOn: "2026-11-19", source: "Internal vendor agreement",
        rows: [{ productId: product.id, productSku: product.sku, supplier: "Workflow supply", supplierSku: "SUP-WF-01", unit: "box", unitCost: "48.25" }],
      }, 201);
      const rates = await request(operations, "/inventory/supplier-crosswalk?asOf=2026-11-20");
      const unitCost = rates.find((row) => row.productId === product.id && row.supplierSku === "SUP-WF-01").latestPrice.unitCost;
      const order = await request(operations, "/inventory/purchase-orders", "POST", {
        supplier: "Workflow supply", warehouseId: warehouse.id, idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, quantity: 6, unitCost }],
      }, 201);
      const orderPath = `/inventory/purchase-orders/${order.id}`;
      const placed = await request(operations, orderPath, "PATCH", { revision: order.revision, status: "Ordered" });
      const lineId = placed.lines[0].id;
      const firstReceipt = { revision: placed.revision, idempotencyKey: randomUUID(), reference: "WF-1",
        lines: [{ lineId, quantity: 4, binId: bin.id }] };
      const partial = await request(operations, `${orderPath}/receive`, "POST", firstReceipt, 201);
      assert.equal(partial.order.status, "Partially received");
      assert.equal((await request(operations, `${orderPath}/receive`, "POST", firstReceipt, 201)).receipt.id, partial.receipt.id);
      const readiness = await request(operations, `${jobPath}/readiness?targetStage=Scheduled`);
      assert.ok([...readiness.blockers, ...readiness.warnings].some((warning) => warning.code === `material_shortage_${product.id}`));
      const finalReceipt = await request(operations, `${orderPath}/receive`, "POST", {
        revision: partial.order.revision, idempotencyKey: randomUUID(), reference: "WF-2",
        lines: [{ lineId, quantity: 2, binId: bin.id, unitCost: "57.25" }],
      }, 201);
      assert.equal(finalReceipt.order.status, "Received");
      await request(operations, `${jobPath}/material-readiness`, "POST", { received: true, supplier: order.supplier }, 201);
      const reservation = await request(operations, "/inventory/reservations", "POST", {
        productId: product.id, warehouseId: warehouse.id, jobId: job.id, quantity: 5, idempotencyKey: randomUUID(),
      }, 201);

      const crew = await request(operations, "/crews", "POST", {
        name: "Internal flooring crew", timezone: "America/New_York", size: 2, dailyCapacityHours: 8, workingDays: [1, 2, 3, 4, 5],
      }, 201);
      const booking = await request(operations, "/bookings", "POST", {
        jobId: job.id, crewId: crew.id, startAt: "2026-12-07T09:00:00-05:00", endAt: "2026-12-07T11:00:00-05:00", plannedLaborHours: 4,
      }, 201);
      const moved = await request(operations, `/bookings/${booking.id}`, "PATCH", {
        revision: booking.revision, startAt: "2026-12-08T09:00:00-05:00", endAt: "2026-12-08T11:00:00-05:00",
      });
      assert.equal(moved.taskId, booking.taskId);
      const sms = await request(owner, "/communications/sms", "POST", {
        to: "+15005550006", body: "Your synthetic installation booking was updated.", idempotencyKey: randomUUID(),
      }, 201);
      assert.equal(sms.status, "captured");
      const currentJob = await request(operations, jobPath);
      const scheduled = await request(operations, `${jobPath}/transition`, "POST", { revision: currentJob.revision, targetStage: "Scheduled" });
      assert.equal(scheduled.status, "Scheduled");

      await request(operations, `/inventory/reservations/${reservation.id}`, "PATCH", {
        revision: reservation.revision, status: "Consumed", binId: bin.id, labelCode: "SUP-WF-01",
      });
      const issue = (await request(operations, `/inventory/movements?productId=${product.id}`)).find((move) => move.kind === "consume");
      await request(operations, "/inventory/movements", "POST", {
        jobId: job.id, productId: product.id, warehouseId: warehouse.id, binId: bin.id, returnOfMovementId: issue.id,
        kind: "return", quantity: 1, reason: "Usable box returned after installation", idempotencyKey: randomUUID(),
      }, 201);
      const usage = await request(operations, `${jobPath}/material-usage`);
      assert.equal(usage.reduce((sum, item) => sum + item.quantity, 0), 4);
      assert.equal(usage.reduce((sum, item) => sum + item.cost, 0), 193);
      const stock = (await request(operations, "/inventory/summary")).find((entry) => entry.productId === product.id);
      assert.equal(stock.onHand, 2);
      assert.equal(stock.reserved, 0);

      const portalPath = `/public/jobs/${job.shareToken}`;
      assert.ok(!(await request(null, portalPath)).invoices.some((entry) => entry.id === invoice.id));
      await request(owner, `/invoices/${invoice.id}`, "PATCH", { status: "Sent" });
      const publicInvoice = (await request(null, portalPath)).invoices.find((entry) => entry.id === invoice.id);
      assert.equal(publicInvoice.total, invoice.total);
      assert.equal(publicInvoice.balanceAmount, invoice.total);
      const reviews = (await request(owner, "/quickbooks/queue")).filter((entry) => entry.entityType === "invoice" && entry.localId === invoice.id);
      assert.ok(reviews.length > 0 && reviews.every((entry) => entry.status === "pending_approval"));
      const cancelled = await request(operations, `/bookings/${booking.id}`, "PATCH", { revision: moved.revision, status: "Cancelled" });
      assert.equal(cancelled.status, "Cancelled");
      assert.equal(cancelled.taskId, booking.taskId);
      await request(operations, `/crews/${crew.id}`, "PATCH", { revision: crew.revision, active: false });
    });
    await run("draft invoices stay private until issued", async () => {
      const publicPath = "/public/jobs/preserve-share-token";
      const existing = await request(null, publicPath);
      const draft = await request(owner, "/invoices", "POST", {
        jobId: "legacy-job", customerName: "Same name", status: "Draft",
        lineItems: [{ id: randomUUID(), description: "Draft material line", category: "Materials", quantity: 3, unitPrice: 48 }],
      }, 201);
      const beforeSend = await request(null, publicPath);
      assert.deepEqual(beforeSend.invoices, existing.invoices);
      assert.deepEqual(beforeSend.balance, existing.balance);
      await request(owner, `/invoices/${draft.id}`, "PATCH", { status: "Sent" });
      const afterSend = await request(null, publicPath);
      assert.equal(afterSend.invoices.find((invoice) => invoice.id === draft.id)?.lineItems[0]?.description, "Draft material line");
    });
    await run("crew overlap and stale booking writes are rejected under concurrency", async () => {
      const crew = await request(operations, "/crews", "POST", { name: "Test crew", timezone: "America/New_York", size: 2, dailyCapacityHours: 4, workingDays: [1, 2, 3, 4, 5] }, 201);
      const booking = { crewId: crew.id, jobId, startAt: "2026-10-26T09:00:00-04:00", endAt: "2026-10-26T11:00:00-04:00", plannedLaborHours: 4 };
      const attempts = await Promise.all([fetch(base + "/bookings", { method: "POST", headers: { "Content-Type": "application/json", Cookie: operations.cookie, "x-csrf-token": operations.csrf }, body: JSON.stringify(booking) }), fetch(base + "/bookings", { method: "POST", headers: { "Content-Type": "application/json", Cookie: operations.cookie, "x-csrf-token": operations.csrf }, body: JSON.stringify(booking) })]);
      assert.deepEqual(attempts.map(response => response.status).sort(), [201, 409]);
      const saved = await attempts.find(response => response.status === 201).json();
      assert.ok(saved.taskId); const task = (await database.query("SELECT booking_id FROM tasks WHERE id=$1", [saved.taskId])).rows[0]; assert.equal(task.booking_id, saved.id);
      await request(operations, `/bookings/${saved.id}`, "PATCH", { revision: saved.revision, notes: "Confirmed notes" });
      await request(operations, `/bookings/${saved.id}`, "PATCH", { revision: saved.revision, notes: "Stale edit" }, 409);
      await request(operations, "/bookings", "POST", { ...booking, startAt: "2026-10-26T12:00:00-04:00", endAt: "2026-10-26T15:00:00-04:00", plannedLaborHours: 6 }, 409);
      const state = (await request(operations, "/bookings")).find(row => row.id === saved.id); assert.equal(state.calendarSyncStatus, "pending");
    });
    await run("inventory reservations cannot oversell and consumption retries cannot double charge stock", async () => {
      const reserve = quantity => fetch(base + "/inventory/reservations", { method: "POST", headers: { "Content-Type": "application/json", Cookie: operations.cookie, "x-csrf-token": operations.csrf }, body: JSON.stringify({ productId: "box-product", jobId, quantity, idempotencyKey: randomUUID() }) });
      const attempts = await Promise.all([reserve(8), reserve(8)]); assert.deepEqual(attempts.map(response => response.status).sort(), [201, 409]);
      const reservation = await attempts.find(response => response.status === 201).json();
      const consumed = await Promise.all([request(operations, `/inventory/reservations/${reservation.id}`, "PATCH", { revision: reservation.revision, status: "Consumed" }), request(operations, `/inventory/reservations/${reservation.id}`, "PATCH", { revision: reservation.revision, status: "Consumed" })]);
      assert.equal(consumed[0].id, consumed[1].id);
      assert.equal((await database.query("SELECT quantity_on_hand FROM products WHERE id='box-product'")).rows[0].quantity_on_hand, 4.5);
      assert.equal((await database.query("SELECT count(*)::int AS n FROM material_usage WHERE product_id='box-product'")).rows[0].n, 1);
      const usage = await request(operations, `/jobs/${jobId}/material-usage`); assert.equal(usage[0].quantity, 8); assert.equal(usage[0].cost, 80);
      const receipt = { productId: "box-product", kind: "receipt", quantity: 2, reason: "Test delivery", idempotencyKey: randomUUID() };
      await Promise.all([request(operations, "/inventory/movements", "POST", receipt, 201), request(operations, "/inventory/movements", "POST", receipt, 201)]);
      assert.equal((await database.query("SELECT quantity_on_hand FROM products WHERE id='box-product'")).rows[0].quantity_on_hand, 6.5);
      const rows = (await database.query("SELECT p.id,p.quantity_on_hand,sum(m.quantity) AS ledger FROM products p JOIN inventory_movements m ON m.product_id=p.id GROUP BY p.id")).rows;
      for (const row of rows) assert.equal(row.quantity_on_hand, Number(row.ledger));
      const conflictKey = randomUUID();
      const keyCollision = await Promise.all(["area-product", "box-product"].map(productId => fetch(base + "/inventory/movements", { method: "POST", headers: { "Content-Type": "application/json", Cookie: operations.cookie, "x-csrf-token": operations.csrf }, body: JSON.stringify({ productId, kind: "receipt", quantity: 1, reason: "Concurrent request key", idempotencyKey: conflictKey }) })));
      assert.deepEqual(keyCollision.map(response => response.status).sort(), [201, 409]);
      assert.equal((await database.query("SELECT count(*)::int AS n FROM inventory_movements WHERE idempotency_key=$1", [conflictKey])).rows[0].n, 1);
    });
    await run("warehouse stock, reservations and returns reconcile through transfer retries", async () => {
      const north = await request(operations, "/inventory/warehouses", "POST", { name: "Fixture North" }, 201);
      const south = await request(owner, "/inventory/warehouses", "POST", { name: "Fixture South" }, 201);
      await request(operations, "/inventory/warehouses", "POST", { name: "fixture north" }, 409);
      await request(sales, "/inventory/warehouses", "GET", undefined, 403);
      const product = await request(owner, "/products", "POST", {
        name: "Warehouse fixture flooring", sku: "FIXTURE-LOCATIONS", category: "Tile", unit: "box", quantityOnHand: 12, cost: 48,
      }, 201);
      const otherProduct = await request(owner, "/products", "POST", {
        name: "Other stock label fixture", sku: "FIXTURE-OTHER-LABEL", category: "Tile", unit: "box", cost: 48,
      }, 201);
      const labelRows = [product, otherProduct].map((entry, index) => ({
        productId: entry.id, productSku: entry.sku, supplier: "Fixture labels", supplierSku: `0000${index + 8}`,
        manufacturerPartNumber: "SHARED-MFR-9", unit: "box", unitCost: "48",
      }));
      await request(owner, "/inventory/supplier-crosswalk/approve", "POST", {
        effectiveOn: "2026-11-20", source: "Label fixture", rows: labelRows,
      }, 201);
      const verifyLabel = "/inventory/verify-product-label";
      assert.deepEqual(await request(operations, verifyLabel, "POST", { productId: product.id, labelCode: " 00008 " }), { matched: true });
      assert.match((await request(operations, verifyLabel, "POST", { productId: product.id, labelCode: "shared-mfr-9" }, 409)).error, /multiple products/);
      assert.match((await request(operations, verifyLabel, "POST", { productId: product.id, labelCode: otherProduct.sku }, 409)).error, /different product/);
      const summary = async () => (await request(operations, "/inventory/summary")).find((row) => row.productId === product.id);
      const location = (stock, warehouseId) => stock.locations.find((row) => row.warehouseId === warehouseId);
      assert.equal(location(await summary(), null).onHand, 12);

      const opening = {
        productId: product.id, sourceWarehouseId: null, destinationWarehouseId: north.id,
        quantity: 8, reason: "Counted legacy stock", idempotencyKey: randomUUID(),
      };
      const assignments = await Promise.all([
        request(operations, "/inventory/transfers", "POST", opening, 201),
        request(operations, "/inventory/transfers", "POST", opening, 201),
      ]);
      assert.equal(assignments[0].id, assignments[1].id);
      assert.equal(assignments[0].status, "Received");
      assert.equal(location(await summary(), null).onHand, 4);
      assert.equal(location(await summary(), north.id).onHand, 8);
      const reservation = await request(operations, "/inventory/reservations", "POST", {
        productId: product.id, warehouseId: north.id, jobId, quantity: 4, idempotencyKey: randomUUID(),
      }, 201);
      const transferInput = {
        productId: product.id, sourceWarehouseId: north.id, destinationWarehouseId: south.id,
        quantity: 3, reason: "Delivery run", idempotencyKey: randomUUID(),
      };
      await request(operations, "/inventory/transfers", "POST", { ...transferInput, quantity: 5 }, 409);
      const transfer = await request(operations, "/inventory/transfers", "POST", transferInput, 201);
      assert.equal(transfer.status, "In transit");
      const dispatched = await summary();
      assert.equal(dispatched.onHand, 9);
      assert.deepEqual(location(dispatched, north.id), { warehouseId: north.id, onHand: 5, reserved: 4, available: 1 });
      assert.equal(location(dispatched, south.id), undefined);
      const arrivals = await Promise.all([
        request(operations, `/inventory/transfers/${transfer.id}/receive`, "POST"),
        request(operations, `/inventory/transfers/${transfer.id}/receive`, "POST"),
      ]);
      assert.equal(arrivals[0].receivedAt, arrivals[1].receivedAt);
      const received = await summary();
      assert.equal(received.onHand, 12);
      assert.equal(location(received, south.id).onHand, 3);

      const issueReservation = `/inventory/reservations/${reservation.id}`;
      const consumeReservation = { revision: reservation.revision, status: "Consumed" };
      await request(operations, issueReservation, "PATCH", { ...consumeReservation, labelCode: otherProduct.sku }, 409);
      assert.equal((await request(operations, "/inventory/reservations")).find((entry) => entry.id === reservation.id).status, "Active");
      await request(operations, issueReservation, "PATCH", { ...consumeReservation, labelCode: "fixture-locations" });
      const movements = await request(operations, `/inventory/movements?productId=${product.id}`);
      const issue = movements.find((movement) => movement.kind === "consume" && movement.jobId === jobId);
      assert.equal(issue.warehouseId, north.id);
      assert.equal(issue.issueUnitCost, "48");
      const repricedProduct = (await request(owner, "/products")).find((row) => row.id === product.id);
      await request(owner, `/products/${product.id}`, "PATCH", { revision: repricedProduct.revision, cost: 79 });
      const leftover = {
        productId: product.id, jobId, warehouseId: south.id, returnOfMovementId: issue.id,
        kind: "return", quantity: 2, reason: "Usable leftovers from installation", idempotencyKey: randomUUID(),
      };
      await request(operations, "/inventory/movements", "POST", { ...leftover, returnOfMovementId: undefined }, 400);
      const returned = await request(operations, "/inventory/movements", "POST", leftover, 201);
      assert.equal((await request(operations, "/inventory/movements", "POST", leftover, 201)).id, returned.id);
      const jobUsage = (await request(operations, `/jobs/${jobId}/material-usage`)).filter((row) => row.productId === product.id);
      assert.equal(jobUsage.length, 2);
      assert.deepEqual(jobUsage.map(({ movementId, quantity, cost }) => ({ movementId, quantity, cost })).sort((a, b) => b.quantity - a.quantity), [
        { movementId: issue.id, quantity: 4, cost: 192 },
        { movementId: returned.id, quantity: -2, cost: -96 },
      ]);
      await request(operations, "/inventory/movements", "POST", { ...leftover, quantity: 3, idempotencyKey: randomUUID() }, 409);
      const final = await summary();
      assert.equal(final.onHand, 10);
      assert.equal(location(final, north.id).onHand, 1);
      assert.equal(location(final, south.id).onHand, 5);
      assert.equal(location(final, null).onHand, 4);
      const delivery = { productId: product.id, warehouseId: south.id, kind: "receipt", quantity: 2.5, reason: "Supplier delivery", idempotencyKey: randomUUID() };
      const receipt = await request(operations, "/inventory/movements", "POST", delivery, 201);
      assert.equal(receipt.warehouseId, south.id);
      await request(operations, "/inventory/movements", "POST", { ...delivery, warehouseId: north.id }, 409);
      const directIssue = { productId: product.id, jobId, kind: "consume", quantity: 2, reason: "Additional boxes for the job", idempotencyKey: randomUUID() };
      await request(operations, "/inventory/movements", "POST", { ...directIssue, warehouseId: north.id }, 409);
      await request(operations, "/inventory/movements", "POST", { ...directIssue, warehouseId: south.id, labelCode: "SHARED-MFR-9" }, 409);
      await request(operations, "/inventory/movements", "POST", { ...directIssue, warehouseId: south.id, labelCode: "00009" }, 409);
      assert.equal((await summary()).onHand, 12.5);
      await request(operations, "/inventory/movements", "POST", { ...directIssue, warehouseId: south.id, labelCode: "00008" }, 201);
      const afterDirectIssue = await summary();
      assert.equal(afterDirectIssue.onHand, 10.5);
      assert.equal(location(afterDirectIssue, south.id).onHand, 5.5);
      const ledger = (await database.query("SELECT sum(quantity) AS total FROM inventory_movements WHERE product_id=$1", [product.id])).rows[0];
      assert.equal(Number(ledger.total), afterDirectIssue.onHand);
    });
    await run("purchase order receipts reconcile partial deliveries, bins and concurrent retries", async () => {
      const purchasing = "/inventory/purchase-orders";
      const warehouse = await request(operations, "/inventory/warehouses", "POST", { name: "Receiving fixture" }, 201);
      const other = await request(operations, "/inventory/warehouses", "POST", { name: "Overflow fixture" }, 201);
      const bin = (warehouseId, code) => request(operations, "/inventory/bins", "POST", { warehouseId, code }, 201);
      const first = await bin(warehouse.id, "A-01");
      const second = await bin(warehouse.id, "A-02");
      const remote = await bin(other.id, "A-01");
      await request(operations, "/inventory/bins", "POST", { warehouseId: warehouse.id, code: "a-01" }, 409);
      assert.ok((await request(operations, `/inventory/bins?warehouseId=${warehouse.id}`)).every((row) => row.warehouseId === warehouse.id));
      await request(sales, purchasing, "GET", undefined, 403);
      const item = await request(operations, "/products", "POST", {
        name: "Fixture boxed vinyl", sku: "PO-FIXTURE-1", category: "Vinyl Plank", unit: "box", cost: 48,
      }, 201);
      const input = { idempotencyKey: randomUUID(), supplier: "PO fixture supply", warehouseId: warehouse.id, lines: [{ productId: item.id, quantity: 50, unitCost: "48.125" }] };
      const [draft, replay] = await Promise.all([
        request(operations, purchasing, "POST", input, 201), request(operations, purchasing, "POST", input, 201),
      ]);
      assert.equal(draft.id, replay.id);
      assert.match(draft.orderNumber, /^PO-\d{6}$/);
      assert.equal(draft.status, "Draft");
      const path = `${purchasing}/${draft.id}`;
      const firstLine = draft.lines[0];
      assert.equal(firstLine.sku, item.sku);
      assert.equal(firstLine.unitCost, "48.125000");
      const receiving = { revision: draft.revision, idempotencyKey: randomUUID(), reference: "PACK-01", lines: [
        { lineId: firstLine.id, quantity: 20, binId: first.id }, { lineId: firstLine.id, quantity: 10, binId: second.id },
      ] };
      await request(operations, `${path}/receive`, "POST", receiving, 409);
      const edited = await request(operations, path, "PATCH", { revision: draft.revision, notes: "Count on delivery" });
      await request(operations, path, "PATCH", { revision: draft.revision, status: "Ordered" }, 409);
      const ordered = await request(owner, path, "PATCH", { revision: edited.revision, status: "Ordered" });
      receiving.revision = ordered.revision;
      await request(operations, `${path}/receive`, "POST", { ...receiving, lines: [{ ...receiving.lines[0], binId: remote.id }] }, 409);
      await request(operations, `${path}/receive`, "POST", { ...receiving, lines: [{ ...receiving.lines[0], quantity: 51 }] }, 409);
      assert.deepEqual(await request(operations, `${path}/receipts`), []);
      const [partial, identical] = await Promise.all([
        request(operations, `${path}/receive`, "POST", receiving, 201),
        request(operations, `${path}/receive`, "POST", { ...receiving, lines: [...receiving.lines].reverse() }, 201),
      ]);
      assert.equal(partial.receipt.id, identical.receipt.id);
      assert.equal(partial.order.status, "Partially received");
      assert.equal(partial.order.lines[0].receivedQuantity, 30);
      await request(operations, `${path}/receive`, "POST", { ...receiving, reference: "DIFFERENT" }, 409);
      const finalInput = { revision: partial.order.revision, idempotencyKey: randomUUID(), reference: "PACK-02", lines: [{ lineId: firstLine.id, quantity: 20, binId: first.id }] };
      const attempt = (body) => fetch(base + `${path}/receive`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: operations.cookie, "x-csrf-token": operations.csrf }, body: JSON.stringify(body) });
      const concurrent = await Promise.all([attempt(finalInput), attempt({ ...finalInput, idempotencyKey: randomUUID() })]);
      assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
      const completed = await concurrent.find((response) => response.status === 201).json();
      assert.equal(completed.order.status, "Received");
      assert.equal(completed.order.lines[0].receivedQuantity, 50);
      assert.equal((await request(operations, `${path}/receipts`)).length, 2);

      const balances = async () => Object.fromEntries((await request(operations, `/inventory/bin-stock?productId=${item.id}`)).map((row) => [row.binId, row.onHand]));
      assert.deepEqual(await balances(), { [first.id]: 40, [second.id]: 10 });
      const move = { warehouseId: warehouse.id, productId: item.id, fromBinId: first.id, toBinId: second.id, quantity: 5, reason: "Restage cartons", idempotencyKey: randomUUID() };
      const moved = await request(operations, "/inventory/bin-moves", "POST", move, 201);
      assert.equal((await request(operations, "/inventory/bin-moves", "POST", move, 201)).id, moved.id);
      await request(operations, "/inventory/bin-moves", "POST", { ...move, toBinId: remote.id, idempotencyKey: randomUUID() }, 409);
      assert.deepEqual(await balances(), { [first.id]: 35, [second.id]: 15 });

      const reserved = await request(operations, "/inventory/reservations", "POST", { productId: item.id, warehouseId: warehouse.id, jobId, quantity: 3, idempotencyKey: randomUUID() }, 201);
      const issue = { revision: reserved.revision, status: "Consumed" };
      await request(operations, `/inventory/reservations/${reserved.id}`, "PATCH", issue, 409);
      await request(operations, `/inventory/reservations/${reserved.id}`, "PATCH", { ...issue, binId: second.id });
      const sent = await request(operations, "/inventory/transfers", "POST", {
        productId: item.id, sourceWarehouseId: warehouse.id, sourceBinId: first.id,
        destinationWarehouseId: other.id, quantity: 4, reason: "Warehouse stock relocation", idempotencyKey: randomUUID(),
      }, 201);
      await request(operations, `/inventory/transfers/${sent.id}/receive`, "POST", { destinationBinId: second.id }, 409);
      await request(operations, `/inventory/transfers/${sent.id}/receive`, "POST", { destinationBinId: remote.id });
      assert.deepEqual(await balances(), { [first.id]: 31, [second.id]: 12, [remote.id]: 4 });
      const summary = (await request(operations, "/inventory/summary")).find((row) => row.productId === item.id);
      assert.equal(summary.onHand, 47);
      assert.equal(summary.locations.find((row) => row.warehouseId === warehouse.id).onHand, 43);
      assert.equal((await request(operations, purchasing)).find((row) => row.id === draft.id).status, "Received");

      const fractional = await request(owner, "/products", "POST", {
        name: "Fractional inventory fixture", sku: "PO-FRACTIONAL", category: "Carpet", unit: "sqft", quantityOnHand: 12345,
      }, 201);
      const unitDraft = await request(operations, purchasing, "POST", {
        supplier: "PO fixture supply", warehouseId: warehouse.id, lines: [{ productId: fractional.id, quantity: 0.000001, unitCost: "2" }],
      }, 201);
      const unitPath = `${purchasing}/${unitDraft.id}`;
      const unitOrder = await request(operations, unitPath, "PATCH", { revision: unitDraft.revision, status: "Ordered" });
      await request(operations, `${unitPath}/receive`, "POST", {
        revision: unitOrder.revision, idempotencyKey: randomUUID(), lines: [{ lineId: unitOrder.lines[0].id, quantity: 0.000001, binId: first.id }],
      }, 201);
      const fractionalBin = await request(operations, `/inventory/bin-stock?productId=${fractional.id}`);
      assert.equal(fractionalBin[0].onHand, 0.000001);
      assert.equal((await request(operations, "/products")).find((product) => product.id === fractional.id).quantityOnHand, 12345.000001);
      await request(operations, "/inventory/bin-moves", "POST", {
        warehouseId: warehouse.id, productId: fractional.id, fromBinId: second.id, toBinId: first.id,
        quantity: 0.000001, reason: "Empty source bin", idempotencyKey: randomUUID(),
      }, 409);
    });
    await run("purchase prices follow FIFO stock through bins, warehouses, job issues and partial returns", async () => {
      const purchase = "/inventory/purchase-orders";
      const movements = "/inventory/movements";
      const source = await request(operations, "/inventory/warehouses", "POST", { name: "FIFO source fixture" }, 201);
      const destination = await request(operations, "/inventory/warehouses", "POST", { name: "FIFO destination fixture" }, 201);
      const bin = (warehouseId, code) => request(operations, "/inventory/bins", "POST", { warehouseId, code }, 201);
      const first = await bin(source.id, "A-01");
      const staged = await bin(source.id, "A-02");
      const arrival = await bin(destination.id, "B-01");
      const product = await request(operations, "/products", "POST", {
        name: "Purchase cost fixture cartons", sku: "FIFO-PURCHASE-FIXTURE", category: "Tile", unit: "box", cost: 70,
      }, 201);
      const baseMove = { productId: product.id, warehouseId: source.id, binId: first.id };
      await request(operations, movements, "POST", { ...baseMove, kind: "receipt", quantity: 1, reason: "Legacy cost unknown", idempotencyKey: randomUUID() }, 201);
      const order = await request(operations, purchase, "POST", {
        supplier: "FIFO fixture supply", warehouseId: source.id, lines: [{ productId: product.id, quantity: 6, unitCost: "10.123456" }],
      }, 201);
      const orderPath = `${purchase}/${order.id}`;
      const ordered = await request(operations, orderPath, "PATCH", { revision: order.revision, status: "Ordered" });
      const lineId = ordered.lines[0].id;
      const firstReceipt = await request(operations, `${orderPath}/receive`, "POST", {
        idempotencyKey: randomUUID(), revision: ordered.revision, lines: [{ lineId, quantity: 2, binId: first.id }],
      }, 201);
      assert.equal(firstReceipt.receipt.lines[0].unitCost, "10.123456");
      const revisedReceipt = { idempotencyKey: randomUUID(), revision: firstReceipt.order.revision, lines: [{ lineId, quantity: 4, binId: first.id, unitCost: "20.50" }] };
      const [received, replay] = await Promise.all([
        request(operations, `${orderPath}/receive`, "POST", revisedReceipt, 201),
        request(operations, `${orderPath}/receive`, "POST", revisedReceipt, 201),
      ]);
      assert.equal(received.receipt.id, replay.receipt.id);
      assert.equal(received.receipt.lines[0].unitCost, "20.500000");
      await request(operations, `${orderPath}/receive`, "POST", {
        ...revisedReceipt, lines: [{ ...revisedReceipt.lines[0], unitCost: "7.00" }],
      }, 409);
      await request(operations, "/inventory/bin-moves", "POST", {
        productId: product.id, warehouseId: source.id, fromBinId: first.id, toBinId: staged.id,
        quantity: 7, reason: "Restage priced and unpriced cartons", idempotencyKey: randomUUID(),
      }, 201);
      const transfer = await request(operations, "/inventory/transfers", "POST", {
        productId: product.id, sourceWarehouseId: source.id, sourceBinId: staged.id, destinationWarehouseId: destination.id,
        quantity: 7, reason: "Keep the lot costs with the stock", idempotencyKey: randomUUID(),
      }, 201);
      await request(operations, `/inventory/transfers/${transfer.id}/receive`, "POST", { destinationBinId: arrival.id });
      const setCatalogCost = async (cost) => {
        const current = (await request(operations, "/products")).find(({ id }) => id === product.id);
        await request(operations, `/products/${product.id}`, "PATCH", { revision: current.revision, cost });
      };
      await setCatalogCost(99);

      const issueLocation = { productId: product.id, warehouseId: destination.id, jobId };
      const billCount = async () => (await database.query("SELECT count(*) FROM quickbooks_sync_jobs WHERE entity_type='vendor_bill'")).rows[0].count;
      const billsBeforeIssues = await billCount();
      const reservation = await request(operations, "/inventory/reservations", "POST", { ...issueLocation, quantity: 4, idempotencyKey: randomUUID() }, 201);
      await request(operations, `/inventory/reservations/${reservation.id}`, "PATCH", { revision: reservation.revision, status: "Consumed", binId: arrival.id });
      const movementsForSku = () => request(operations, `${movements}?productId=${product.id}`);
      const issued = (await movementsForSku()).find((movement) => movement.kind === "consume");
      assert.deepEqual(issued.costAllocations.map((slice) => [slice.source, slice.quantity, Number(slice.unitCost)]), [
        ["catalog", 1, 99], ["purchase_order", 2, 10.123456], ["purchase_order", 1, 20.5],
      ]);
      const costFor = async (movementId) => (await database.query("SELECT cost FROM material_usage WHERE movement_id=$1", [movementId])).rows[0]?.cost;
      assert.equal(await costFor(issued.id), 139.75);
      await setCatalogCost(120);
      const returnInput = { ...issueLocation, binId: arrival.id, returnOfMovementId: issued.id, kind: "return", reason: "Leftover cartons", idempotencyKey: randomUUID() };
      const partial = await request(operations, movements, "POST", { ...returnInput, quantity: 1 }, 201);
      assert.equal(await costFor(partial.id), -20.5);
      assert.equal((await request(operations, movements, "POST", { ...returnInput, quantity: 1 }, 201)).id, partial.id);
      const remainder = await request(operations, movements, "POST", { ...returnInput, quantity: 3, idempotencyKey: randomUUID() }, 201);
      assert.equal(await costFor(remainder.id), -119.25);
      await request(operations, movements, "POST", { ...returnInput, quantity: 1, idempotencyKey: randomUUID() }, 409);

      const direct = await request(operations, movements, "POST", { ...issueLocation, binId: arrival.id, quantity: 4, kind: "consume", reason: "Reissue earlier valued lots", idempotencyKey: randomUUID() }, 201);
      assert.equal(await costFor(direct.id), 61.25);
      const last = { ...issueLocation, binId: arrival.id, quantity: 3, kind: "consume", reason: "Concurrent issue", idempotencyKey: randomUUID() };
      const postIssue = (body) => fetch(base + movements, { method: "POST", headers: { "Content-Type": "application/json", Cookie: operations.cookie, "x-csrf-token": operations.csrf }, body: JSON.stringify(body) });
      const concurrent = await Promise.all([postIssue(last), postIssue({ ...last, idempotencyKey: randomUUID() })]);
      assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
      assert.equal(await costFor((await concurrent.find((response) => response.status === 201).json()).id), 140);
      assert.deepEqual((await database.query("SELECT sum(quantity),count(*) FILTER (WHERE kind='receipt' AND acquisition_unit_cost IS NOT NULL) AS priced FROM inventory_movements WHERE product_id=$1", [product.id])).rows[0], { sum: 0, priced: "2" });

      const receivedDirect = await request(operations, movements, "POST", { ...issueLocation, jobId: undefined, binId: arrival.id, quantity: 1, kind: "receipt", unitCost: "100000.00", reason: "Actual receipt outside a PO", idempotencyKey: randomUUID() }, 201);
      assert.equal(receivedDirect.acquisitionUnitCost, "100000.000000");
      const fractionalIssue = await request(operations, movements, "POST", { ...last, quantity: 1, idempotencyKey: randomUUID() }, 201);
      assert.equal(await costFor(fractionalIssue.id), 100000);
      const fractionReturn = { ...returnInput, returnOfMovementId: fractionalIssue.id, idempotencyKey: randomUUID() };
      const almostAll = await request(operations, movements, "POST", { ...fractionReturn, quantity: 0.999999 }, 201);
      assert.equal(await costFor(almostAll.id), -99999.9);
      const lastMicrounit = await request(operations, movements, "POST", { ...fractionReturn, quantity: 0.000001, idempotencyKey: randomUUID() }, 201);
      assert.equal(await costFor(lastMicrounit.id), -0.1);
      assert.equal(await billCount(), billsBeforeIssues);
    });
    await run("damaged purchase receipts keep rejected quantities open and outside inventory", async () => {
      const purchase = "/inventory/purchase-orders";
      const warehouse = await request(operations, "/inventory/warehouses", "POST", { name: "Damage inspection fixture" }, 201);
      const acceptedBin = await request(operations, "/inventory/bins", "POST", { warehouseId: warehouse.id, code: "GOOD" }, 201);
      const product = await request(operations, "/products", "POST", {
        name: "Damage fixture cartons", sku: "PO-DAMAGE-FIXTURE", category: "Tile", unit: "box", cost: 75,
      }, 201);
      const draft = await request(operations, purchase, "POST", { supplier: "Damage fixture vendor", warehouseId: warehouse.id, lines: [{ productId: product.id, quantity: 10, unitCost: "17.25" }] }, 201);
      const path = `${purchase}/${draft.id}`;
      const ordered = await request(operations, path, "PATCH", { revision: draft.revision, status: "Ordered" });
      const lineId = ordered.lines[0].id;
      const post = (body, status = 201) => request(operations, `${path}/receive`, "POST", body, status);
      const damageOnly = {
        revision: ordered.revision, idempotencyKey: randomUUID(), reference: "DAMAGED-A",
        lines: [{ lineId, quantity: 0, damagedQuantity: 2, damageNote: "  Cartons crushed  ", binId: null }],
      };
      await request(sales, `${path}/receive`, "POST", damageOnly, 403);
      await post({ ...damageOnly, lines: [{ ...damageOnly.lines[0], quantity: 4, damagedQuantity: 7 }] }, 409);
      await post({ ...damageOnly, lines: [{ ...damageOnly.lines[0], lineId: "different-order-line" }] }, 400);
      await post({ ...damageOnly, lines: [{ ...damageOnly.lines[0], damagedQuantity: -1 }] }, 400);
      await post({ ...damageOnly, lines: [{ ...damageOnly.lines[0], binId: acceptedBin.id }] }, 400);
      assert.deepEqual(await request(operations, `${path}/receipts`), []);
      const [recorded, retried] = await Promise.all([post(damageOnly), post(damageOnly)]);
      assert.equal(recorded.receipt.id, retried.receipt.id);
      assert.equal(recorded.order.revision, ordered.revision + 1);
      assert.equal(recorded.order.status, "Ordered");
      assert.equal(recorded.order.lines[0].receivedQuantity, 0);
      const [{ quantity: accepted, damagedQuantity, damageNote, movementId, unitCost, productId }] = recorded.receipt.lines;
      assert.deepEqual({ accepted, damagedQuantity, damageNote, movementId, unitCost, productId }, {
        accepted: 0, damagedQuantity: 2, damageNote: "Cartons crushed", movementId: null, unitCost: null, productId: product.id,
      });
      assert.deepEqual(await request(operations, `/inventory/bin-stock?productId=${product.id}`), []);
      await post({ ...damageOnly, lines: [{ ...damageOnly.lines[0], damageNote: "Changed note" }] }, 409);

      const mixed = await post({ revision: recorded.order.revision, idempotencyKey: randomUUID(), lines: [
        { lineId, quantity: 4, damagedQuantity: 1, binId: acceptedBin.id, unitCost: "16.50" },
      ] });
      assert.equal(mixed.order.status, "Partially received");
      assert.equal(mixed.order.lines[0].receivedQuantity, 4);
      assert.equal(mixed.receipt.lines[0].damagedQuantity, 1);
      assert.equal(mixed.receipt.lines[0].unitCost, "16.500000");

      const cleanInput = { revision: mixed.order.revision, idempotencyKey: randomUUID(), reference: "REPLACEMENTS", lines: [{ lineId, quantity: 6, binId: acceptedBin.id }] };
      const replacement = await post(cleanInput);
      const oldHash = createHash("sha256").update(JSON.stringify([cleanInput.reference, cleanInput.lines])).digest("hex");
      assert.equal((await database.query("SELECT request_hash FROM purchase_receipts WHERE id=$1", [replacement.receipt.id])).rows[0].request_hash, oldHash);
      assert.equal((await post(cleanInput)).receipt.id, replacement.receipt.id);
      assert.equal(replacement.order.status, "Received");
      const history = await request(operations, `${path}/receipts`);
      assert.equal(history.length, 3);
      assert.equal(history.reduce((total, receipt) => total + receipt.lines[0].damagedQuantity, 0), 3);
      const stock = await request(operations, `/inventory/bin-stock?productId=${product.id}`);
      assert.equal(stock[0].onHand, 10);
      const issue = await request(operations, "/inventory/movements", "POST", {
        productId: product.id, jobId, warehouseId: warehouse.id, binId: acceptedBin.id, kind: "consume", quantity: 10,
        reason: "Issue accepted cartons only", idempotencyKey: randomUUID(),
      }, 201);
      assert.equal((await database.query("SELECT cost FROM material_usage WHERE movement_id=$1", [issue.id])).rows[0].cost, 169.5);
    });
    await run("catalog CSV imports opening counts atomically and protects existing SKUs", async () => {
      const route = "/products/catalog-import";
      const csv = [
        "internal_sku,name,category,unit,unit_cost,sale_price,supplier,warehouse,on_hand,coverage_per_unit,source_item_id",
        '00014,"Vinyl, slate",Vinyl Tile,box,48,75,Fixture Supply,Fixture North,30,20,',
        '00014,"Vinyl, slate",Vinyl Tile,box,48,75,Fixture Supply,fixture south,20,20,',
        ",Fixture floor,Tile,sqft,2.50,5,,,,,floors:00015",
      ].join("\n");
      await request(sales, `${route}/preview`, "POST", { csv }, 403);
      const invalidCsv = `${csv}\n00016,Unknown location,Tile,box,1,2,,Missing warehouse,9,,`;
      const invalid = await request(operations, `${route}/preview`, "POST", { csv: invalidCsv });
      assert.equal(invalid.rows.at(-1).status, "error");
      await request(operations, route, "POST", { csv: invalidCsv, previewKey: invalid.previewKey }, 400);
      assert.equal((await request(operations, "/products")).some((product) => product.sku === "00014"), false);

      const preview = await request(operations, `${route}/preview`, "POST", { csv });
      assert.deepEqual(preview.rows.map((row) => row.status), ["new", "new", "new"]);
      assert.equal(preview.newProducts, 2);
      assert.match(preview.rows[2].sku, /^SKU-[0-9A-F]{16}$/);
      await request(operations, route, "POST", { csv: csv.replace("Fixture floor", "Changed floor"), previewKey: preview.previewKey }, 409);
      const attempt = () => fetch(base + route, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: operations.cookie, "x-csrf-token": operations.csrf },
        body: JSON.stringify({ csv, previewKey: preview.previewKey }),
      });
      const concurrently = await Promise.all([attempt(), attempt()]);
      assert.deepEqual(concurrently.map((response) => response.status).sort(), [201, 409]);
      assert.deepEqual(await concurrently.find((response) => response.status === 201).json(), { created: 2 });
      const products = await request(operations, "/products");
      const stockProduct = products.find((product) => product.sku === "00014");
      assert.equal(stockProduct.coveragePerUnit, 20);
      const stock = (await request(operations, "/inventory/summary")).find((row) => row.productId === stockProduct.id);
      assert.equal(stock.onHand, 50);
      assert.deepEqual(stock.locations.map((row) => row.onHand).sort((a, b) => a - b), [0, 20, 30]);
      const queue = await database.query("select status from quickbooks_sync_jobs where local_id=$1 and entity_type='item'", [stockProduct.id]);
      assert.deepEqual(queue.rows, [{ status: "pending_approval" }]);
      const repeat = await request(operations, `${route}/preview`, "POST", { csv });
      assert.equal(repeat.newProducts, 0);
      assert.ok(repeat.rows.every((row) => row.status === "existing"));
      assert.deepEqual(await request(operations, route, "POST", { csv, previewKey: repeat.previewKey }), { created: 0 });
      await request(operations, "/products", "POST", { name: "Duplicate", sku: " 00014 ", category: "Tile", unit: "box" }, 409);
      const other = products.find((product) => product.sku === preview.rows[2].sku);
      await request(operations, `/products/${other.id}`, "PATCH", { sku: "00014", revision: other.revision }, 409);
    });
    await run("supplier crosswalk approvals persist mappings and dated costs without changing the catalog", async () => {
      const box = await request(owner, "/products", "POST", { name: "Supplier fixture boxes", sku: "KF-001", category: "Tile", unit: "box", cost: 10 }, 201);
      const area = await request(owner, "/products", "POST", { name: "Supplier fixture roll", sku: "KF-002", category: "Carpet", unit: "sqft", cost: 2 }, 201);
      const route = "/inventory/supplier-crosswalk/approve";
      const row = { productId: box.id, productSku: box.sku, supplier: "Fixture Supply", supplierSku: "00042", manufacturerPartNumber: "M-42", unit: box.unit, unitCost: "17.324125" };
      const input = { effectiveOn: "2026-11-19", source: "Fixture vendor agreement", rows: [row] };
      await request(operations, route, "POST", input, 403);
      await request(sales, "/inventory/supplier-crosswalk", "GET", undefined, 403);
      await request(owner, route, "POST", { ...input, rows: [row, { ...row, supplier: "fixture supply" }] }, 400);
      assert.deepEqual(await request(owner, route, "POST", input, 201), { aliasesAdded: 1, pricesAdded: 1, alreadyApproved: 0 });
      assert.deepEqual(await request(owner, route, "POST", { ...input, rows: [{ ...row, supplier: "FIXTURE SUPPLY" }] }), { aliasesAdded: 0, pricesAdded: 0, alreadyApproved: 1 });
      await request(owner, route, "POST", { ...input, rows: [{ ...row, unitCost: "17.324126" }] }, 409);
      await request(owner, route, "POST", { ...input, rows: [{ ...row, productId: area.id, productSku: area.sku, unit: area.unit }] }, 409);
      await request(owner, route, "POST", { ...input, effectiveOn: "2026-12-01", source: "Future fixture agreement", rows: [{ ...row, unitCost: "18" }] }, 201);
      const alias = (await request(operations, "/inventory/supplier-crosswalk")).find((entry) => entry.supplier === row.supplier && entry.supplierSku === row.supplierSku);
      assert.equal(alias.supplierSku, "00042"); assert.equal(alias.manufacturerPartNumber, "M-42");
      assert.equal(alias.latestPrice.unitCost, "18.000000"); assert.equal(alias.latestPrice.source, "Future fixture agreement");
      const currentAlias = (await request(operations, "/inventory/supplier-crosswalk?asOf=2026-11-20")).find((entry) => entry.id === alias.id);
      assert.equal(currentAlias.latestPrice.unitCost, "17.324125");
      assert.equal(currentAlias.latestPrice.effectiveOn, "2026-11-19");
      const beforeAgreement = (await request(operations, "/inventory/supplier-crosswalk?asOf=2026-11-18")).find((entry) => entry.id === alias.id);
      assert.equal(beforeAgreement.latestPrice, null);
      await request(operations, "/inventory/supplier-crosswalk?asOf=invalid", "GET", undefined, 400);
      assert.equal((await database.query("SELECT count(*)::int AS count FROM supplier_buy_prices WHERE alias_id=$1", [alias.id])).rows[0].count, 2);
      assert.equal((await database.query("SELECT cost FROM products WHERE id=$1", [box.id])).rows[0].cost, box.cost);

      const bills = "/quickbooks/vendor-bills";
      const supplierBill = { mode: "simulated", supplier: "Fixture Supply", billNumber: "FIXTURE-009", billDate: "2026-11-20", billTotal: "18.50", lines: [{ supplierSku: "00042", unit: "box", quantity: "1", unitCost: "18.50" }] };
      await request(operations, `${bills}/preview`, "POST", supplierBill, 403);
      await request(owner, `${bills}/preview`, "POST", { ...supplierBill, mode: "sandbox", vendorId: "22" }, 409);
      const reviewed = await request(owner, `${bills}/preview`, "POST", supplierBill);
      assert.equal(reviewed.lines[0].expectedUnitCost, "17.324125");
      assert.equal(reviewed.lines[0].priceEffectiveOn, "2026-11-19");
      assert.equal(reviewed.lines[0].priceDiffers, true, "compare against the effective rate, not the future rate");
      const prepared = { ...supplierBill, fingerprint: reviewed.fingerprint };
      const staged = await request(owner, bills, "POST", prepared, 201);
      assert.equal((await request(owner, bills, "POST", prepared)).id, staged.id);
      assert.deepEqual(await request(owner, "/quickbooks/queue/approve", "POST", { ids: [staged.id] }), []);
      assert.equal((await request(owner, `${bills}/${staged.id}/approve`, "POST")).status, "demo_completed");
      assert.match((await request(owner, `${bills}/${staged.id}/approve`, "POST")).payload.postedId, /^SIM-BILL-/);
      assert.equal((await request(owner, bills)).length, 1);
      assert.equal((await database.query("SELECT quantity_on_hand FROM products WHERE id=$1", [box.id])).rows[0].quantity_on_hand, 0);
    });
    await run("supplier bills can be reviewed on the normal runtime without a QuickBooks connection", async () => {
      const reviewPort = await unusedPort();
      const reviewBase = `http://127.0.0.1:${reviewPort}/api`;
      const reviewServer = spawn(process.execPath, [path.join(root, `artifacts/api-server/${testAdapter ? "dist-test" : "dist"}/index.mjs`)], {
        cwd: root, windowsHide: true, stdio: "ignore",
        env: { ...apiEnvironment, NODE_ENV: "production", DEMO_MODE: "false", PORT: String(reviewPort), APP_BASE_URL: `http://127.0.0.1:${reviewPort}` },
      });
      try {
        let ready = false;
        for (let attempt = 0; attempt < 100 && reviewServer.exitCode === null; attempt++) {
          try { ready = (await fetch(`${reviewBase}/healthz`)).ok; } catch {}
          if (ready) break;
          await sleep(100);
        }
        assert.ok(ready, "Non-demo test runtime started");
        const bills = "/quickbooks/vendor-bills";
        const input = { mode: "review", supplier: "Fixture Supply", billNumber: "FIXTURE-REVIEW-01", billDate: "2026-11-20", billTotal: "37.00", lines: [{ supplierSku: "00042", unit: "box", quantity: "2", unitCost: "18.50" }] };
        await request(owner, `${bills}/preview`, "POST", input, 409);
        await request(operations, `${bills}/preview`, "POST", input, 403, reviewBase);
        await request(owner, `${bills}/preview`, "POST", { ...input, billTotal: "38.00" }, 409, reviewBase);
        const preview = await request(owner, `${bills}/preview`, "POST", input, 200, reviewBase);
        assert.equal(preview.totalCents, 3700);
        assert.equal(preview.lines[0].internalSku, "KF-001");
        assert.equal(preview.lines[0].expectedUnitCost, "17.324125");
        assert.equal(preview.priceDiffers, true);
        assert.equal("quickBooksBill" in preview, false);
        const staged = await request(owner, bills, "POST", { ...input, fingerprint: preview.fingerprint }, 201, reviewBase);
        assert.equal(staged.status, "pending_approval");
        const reviewed = await request(owner, `${bills}/${staged.id}/approve`, "POST", undefined, 200, reviewBase);
        assert.equal(reviewed.status, "reviewed");
        assert.ok(reviewed.approvedBy && reviewed.completedAt);
        assert.equal("postedId" in reviewed.payload, false);
        const replay = await request(owner, `${bills}/${staged.id}/approve`, "POST", undefined, 200, reviewBase);
        assert.equal(replay.approvedAt, reviewed.approvedAt);
        const history = await request(owner, `${bills}?mode=review`, "GET", undefined, 200, reviewBase);
        assert.deepEqual(history.map((bill) => bill.id), [reviewed.id]);
      } finally {
        await stop(reviewServer);
      }
    });
    await run("callback costs and crew-linked actual labor reload with valid relationships", async () => {
      const callback = await request(operations, "/callbacks", "POST", { jobId, reason: "Fixture touch-up", assignedTo: "Test crew" }, 201);
      const context = await request(installer, `/jobs/${jobId}/entry-context`);
      assert.ok(context.crews.length); assert.ok(context.bookings.length);
      const booking = context.bookings[0];
      await request(installer, `/jobs/${jobId}/labor`, "POST", { date: "2026-10-26", crew: "Test crew", crewId: booking.crewId, bookingId: booking.id, callbackId: callback.id, hours: 2, notes: "Touch-up visit" }, 201);
      const labor = await request(installer, `/jobs/${jobId}/labor`); assert.equal(labor[0].crewId, booking.crewId); assert.equal(labor[0].callbackId, callback.id); assert.equal(labor[0].hours, 2);
      await request(installer, "/jobs/other-job/labor", "POST", { date: "2026-10-26", crew: "Test crew", crewId: booking.crewId, bookingId: booking.id, hours: 1 }, 403);
      await request(operations, `/jobs/${jobId}/material-usage`, "POST", { material: "Touch-up supplies", quantity: 1, cost: 7, callbackId: callback.id }, 201);
      const movement = { productId: "box-product", jobId, callbackId: callback.id, kind: "consume", quantity: 1, reason: "Touch-up material", idempotencyKey: randomUUID() };
      await request(operations, "/inventory/movements", "POST", movement, 201);
      await request(operations, "/inventory/movements", "POST", movement, 201);
      await request(operations, "/inventory/movements", "POST", { ...movement, callbackId: undefined }, 409);
      const reservation = (await request(operations, "/inventory/reservations")).find(row => row.jobId === jobId && row.status === "Consumed");
      await request(operations, `/inventory/reservations/${reservation.id}`, "PATCH", { revision: reservation.revision, status: "Consumed", callbackId: callback.id }, 409);
      await request(operations, "/inventory/movements", "POST", { productId: "box-product", kind: "receipt", quantity: 1, reason: "Receipt", overrideReason: "Cannot claim owner override", idempotencyKey: randomUUID() }, 403);
      const usage = (await request(operations, `/jobs/${jobId}/material-usage`)).filter(row => row.callbackId === callback.id);
      assert.equal(usage.reduce((sum, row) => sum + row.cost, 0), 17);
      await request(operations, "/jobs/other-job/material-usage", "POST", { material: "Wrong callback", quantity: 1, cost: 7, callbackId: callback.id }, 400);
      await request(operations, `/callbacks/${callback.id}`, "PATCH", { status: "Resolved" });
      assert.ok((await request(operations, "/callbacks")).find(row => row.id === callback.id).resolvedAt);
      const metrics = await request(owner, "/metrics?from=2026-10-26&to=2026-10-27");
      assert.equal(metrics.capacityHours, 8); assert.equal(metrics.plannedLaborHours, 4); assert.equal(metrics.actualLaborHours, 2);
      assert.equal(metrics.scheduledUtilization, 50); assert.equal(metrics.actualUtilization, 25);
      assert.equal(metrics.callbacksOpen, 0); assert.equal(metrics.timezone, "America/New_York");
    });
    await run("readiness blocks scheduling and records owner overrides without altering old dates", async () => {
      const job = await request(owner, "/jobs/other-job");
      await request(operations, "/jobs/other-job/transition", "POST", { revision: job.revision, targetStage: "Scheduled" }, 409);
      await request(operations, "/jobs/other-job", "PATCH", { revision: job.revision, status: "Scheduled" }, 409);
      await request(owner, "/auth/persona", "POST", { role: "operations" });
      await request(owner, "/jobs/other-job/transition", "POST", { revision: job.revision, targetStage: "Scheduled", overrideReason: "Preview cannot override" }, 409);
      await request(owner, "/auth/persona", "POST", { role: null });
      await request(owner, "/jobs/other-job/transition", "POST", { revision: job.revision, targetStage: "Scheduled", overrideReason: "Fixture verifies explicit exception audit" });
      assert.equal((await database.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id='other-job' AND action='job.transition_overridden'")).rows[0].n, 1);
      assert.equal((await database.query("SELECT est_start_date FROM jobs WHERE id='legacy-job'")).rows[0].est_start_date, "2020-01-02");
    });
    await run("customer merge preserves document totals, recipient names and old links", async () => {
      const beforeInvoice = (await database.query("SELECT total,paid_amount,balance_amount,customer_name,invoice_number FROM invoices WHERE id='legacy-invoice'")).rows[0];
      await request(owner, "/customers/legacy%3Ajob%3Alegacy-job/merge", "POST", { targetId: "legacy:job:other-job", revision: 1 });
      assert.deepEqual((await database.query("SELECT total,paid_amount,balance_amount,customer_name,invoice_number FROM invoices WHERE id='legacy-invoice'")).rows[0], beforeInvoice);
      assert.equal((await request(owner, "/customers/legacy%3Ajob%3Alegacy-job")).mergedIntoId, "legacy:job:other-job");
      assert.equal((await database.query("SELECT customer_id FROM invoices WHERE id='legacy-invoice'")).rows[0].customer_id, "legacy:job:other-job");
    });
    await run("nullable customer and site edits validate the effective saved relationship", async () => {
      const a = await request(sales, "/customers", "POST", { name: "Link source" }, 201);
      const b = await request(sales, "/customers", "POST", { name: "Link destination" }, 201);
      const site = await request(sales, `/customers/${a.id}/sites`, "POST", { address: "1 Relationship Way" }, 201);
      await request(sales, `/jobs/${jobId}`, "PATCH", { customerId: a.id, siteId: site.id });
      await request(sales, `/jobs/${jobId}`, "PATCH", { customerId: null }, 400);
      const moved = await request(sales, `/jobs/${jobId}`, "PATCH", { customerId: b.id, siteId: null });
      assert.equal(moved.customerId, b.id); assert.equal(moved.siteId ?? null, null);
      const lead = await request(sales, "/leads", "POST", { customerName: a.name, customerId: a.id, siteId: site.id, flooringInterest: "Tile", estimatedValue: 0, source: "Referral", stage: "New" }, 201);
      await request(sales, `/leads/${lead.id}`, "PATCH", { customerId: null }, 400);
      const changedLead = await request(sales, `/leads/${lead.id}`, "PATCH", { customerId: b.id, siteId: null });
      assert.equal(changedLead.customerId, b.id); assert.equal(changedLead.siteId ?? null, null);
      const source = await request(sales, "/estimate-drafts", "POST", { inputs: { ...draft.inputs, customerId: a.id, siteId: site.id } }, 201);
      const converted = await request(sales, `/estimate-drafts/${source.id}/convert`, "POST", { revision: source.revision, target: "proposal" });
      await request(sales, `/proposals/${converted.proposalId}`, "PATCH", { customerId: null }, 400);
      const changedQuote = await request(sales, `/proposals/${converted.proposalId}`, "PATCH", { customerId: b.id, siteId: null });
      assert.equal(changedQuote.customerId, b.id); assert.equal(changedQuote.siteId ?? null, null);
    });
    await run("site creation cannot race a merge and leave a location on the merged source", async () => {
      const source = await request(owner, "/customers", "POST", { name: "Concurrent source" }, 201);
      const target = await request(owner, "/customers", "POST", { name: "Concurrent target" }, 201);
      const blocker = await connect(connections[0]); let mergeRequest, siteRequest, siteFinished = false;
      const post = (route, body) => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", Cookie: owner.cookie, "x-csrf-token": owner.csrf }, body: JSON.stringify(body) });
      try {
        await blocker.query("BEGIN"); await blocker.query("SELECT id FROM customers WHERE id=$1 FOR UPDATE", [source.id]);
        mergeRequest = post(`/customers/${source.id}/merge`, { targetId: target.id, revision: source.revision });
        const waiting = async () => (await database.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%customers%'")).rows[0].n;
        for (let attempt = 0; attempt < 100 && await waiting() < 1; attempt++) await sleep(20);
        assert.ok(await waiting() >= 1, "Merge reached the customer lock");
        siteRequest = post(`/customers/${source.id}/sites`, { address: "2 Concurrent Way" }).then(response => { siteFinished = true; return response; });
        for (let attempt = 0; attempt < 100 && !siteFinished && await waiting() < 2; attempt++) await sleep(20);
        assert.equal(siteFinished, false, "Site creation must hold a customer lock until its insert commits");
        assert.ok(await waiting() >= 2, "Both writes are serialized on the same customer");
        await blocker.query("COMMIT");
        const merged = await mergeRequest, site = await siteRequest;
        assert.equal(merged.status, 200, JSON.stringify(await merged.json()));
        assert.equal(site.status, 404, JSON.stringify(await site.json()));
        assert.equal((await database.query("SELECT count(*)::int AS n FROM customer_sites WHERE customer_id=$1", [source.id])).rows[0].n, 0);
      } finally { await blocker.query("ROLLBACK"); await blocker.end(); await Promise.allSettled([mergeRequest, siteRequest].filter(Boolean)); }
    });
    await run("missing converted draft targets return a conflict without creating duplicate documents", async () => {
      const source = await request(sales, "/estimate-drafts", "POST", { inputs: draft.inputs }, 201);
      const result = await request(sales, `/estimate-drafts/${source.id}/convert`, "POST", { revision: source.revision, target: "proposal" });
      const beforeCount = (await database.query("SELECT count(*)::int AS n FROM proposals")).rows[0].n;
      await database.query("UPDATE estimate_drafts SET converted_proposal_id=$1 WHERE id=$2", [randomUUID(), source.id]);
      try { await request(sales, `/estimate-drafts/${source.id}/convert`, "POST", { revision: source.revision, target: "proposal" }, 409); }
      finally { await database.query("UPDATE estimate_drafts SET converted_proposal_id=$1 WHERE id=$2", [result.proposalId, source.id]); }
      assert.equal((await database.query("SELECT count(*)::int AS n FROM proposals")).rows[0].n, beforeCount);
    });
    await run("historical acceptance dates remain unknown and fractional deposits keep cents", async () => {
      const id = randomUUID(), token = randomUUID();
      await database.query("INSERT INTO proposals (id,customer_id,customer_name,flooring_type,status,estimated_price,deposit_type,deposit_value,share_token,created_at) VALUES ($1,$2,'Historical accepted quote','Tile','Accepted',1234.56,'percent',12.5,$3,'2019-01-01')", [id, customer.id, token]);
      const quote = await request(null, `/public/quotes/${token}`); assert.equal(quote.depositAmount, 154.32);
      const result = await request(sales, `/proposals/${id}/convert`, "POST", {});
      assert.equal(result.job.soldAt ?? null, null); assert.deepEqual(result.job.stageHistory, []);
      assert.equal(result.invoice.total, 1234.56); assert.equal(result.invoice.paidAmount, 0); assert.equal(result.invoice.depositAmount, 0);
    });
    await run("job deletion preserves linked history and still permits truly unused draft removal", async () => {
      await request(owner, `/jobs/${jobId}`, "DELETE", undefined, 409);
      await request(owner, "/jobs/legacy-job", "DELETE", undefined, 409);
      const unusedId = randomUUID(), linkedId = randomUUID(), now = new Date().toISOString();
      for (const id of [unusedId, linkedId]) await database.query("INSERT INTO jobs (id,job_number,customer_name,flooring_type,material_status,priority_level,risk_level,status,created_at,updated_at) VALUES ($1,$1,'Unused draft','Tile','Not Ordered','Medium','Low','New Lead',$2,$2)", [id, now]);
      await database.query("INSERT INTO job_callbacks (id,job_id,reason,created_at,updated_at) VALUES ($1,$2,'Retain recorded callback',$3,$3)", [randomUUID(), linkedId, now]);
      const blocked = await request(owner, `/jobs/${linkedId}`, "DELETE", undefined, 409); assert.match(blocked.error, /callbacks/);
      await request(owner, `/jobs/${unusedId}`, "DELETE", undefined, 204);
      assert.equal((await database.query("SELECT count(*)::int AS n FROM jobs WHERE id=ANY($1)", [[jobId, "legacy-job", linkedId]])).rows[0].n, 3);
      assert.equal((await database.query("SELECT count(*)::int AS n FROM job_callbacks WHERE job_id=$1", [linkedId])).rows[0].n, 1);
    });
    await run("upgraded database backup restores every table exactly and remains migration-ready", async () => {
      await stop(server); server = null; await restored.end(); restored = null;
      await admin.query(`DROP DATABASE "${names[1]}"`); await admin.query(`CREATE DATABASE "${names[1]}"`);
      const backup = path.join(temporary, "upgraded.dump");
      await execute(executable("pg_dump"), ["--format=custom", "--no-owner", "--no-acl", `--file=${backup}`], { env: pgEnvironment(names[0]), windowsHide: true });
      await execute(executable("pg_restore"), ["--exit-on-error", "--no-owner", "--no-acl", `--dbname=${names[1]}`, backup], { env: pgEnvironment(names[1]), windowsHide: true });
      restored = await connect(connections[1]); assert.deepEqual(await snapshot(restored), await snapshot(database));
      await runMigrations(restored, { ...migrationOptions, checkOnly: true });
      t.diagnostic(`Upgraded backup verified across ${Object.keys(await snapshot(restored)).length} tables; SHA-256 ${createHash("sha256").update(await readFile(backup)).digest("hex")}`);
    });
    await run("recovery entry stays read-only despite conflicting environment flags", async () => {
      const businessBefore = await legacySnapshot(database);
      server = spawn(process.execPath, [path.join(root, `artifacts/api-server/${testAdapter ? "dist-test" : "dist"}/recovery.mjs`)], { cwd: root, windowsHide: true, env: { ...apiEnvironment, READ_ONLY_RECOVERY: "false", BACKGROUND_WORKERS_ENABLED: "true", DEMO_ACCESS_ENABLED: "true" }, stdio: ["ignore", "pipe", "pipe"] });
      let recoveryLogs = ""; server.stderr.on("data", data => { recoveryLogs = (recoveryLogs + data).slice(-8000); }); server.stdout.on("data", data => { recoveryLogs = (recoveryLogs + data).slice(-8000); });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) { try { const response = await fetch(`${base}/healthz`); ready = response.ok && response.headers.get("x-catalyst-mode") === "read-only-recovery"; } catch {} if (ready) break; if (server.exitCode !== null) break; await sleep(100); }
      assert.ok(ready, `Recovery did not become ready: ${recoveryLogs}`);
      const session = await login("owner@release.test");
      await request(session, "/jobs"); await request(session, "/auth/session");
      await request(session, "/customers", "POST", { name: "Blocked recovery write" }, 503);
      await request(session, "/products/area-product", "PATCH", { price: 1 }, 503);
      await request(session, "/quickbooks/connect", "GET", undefined, 503);
      await request(null, "/auth/demo", "POST", {}, 503);
      await request(session, "/auth/logout", "POST", {}, 204);
      assert.deepEqual(await legacySnapshot(database), businessBefore);
      await stop(server); server = null;
    });
  } finally {
    await stop(server); if (restored) await restored.end(); if (database) await database.end();
    for (const name of names) { assert.match(name, /^catalyst_(release|restore)_\d+_[a-f0-9]+$/); await admin.query(`DROP DATABASE IF EXISTS "${name}"`); }
    await admin.end(); await rm(temporary, { recursive: true, force: true });
  }
});
