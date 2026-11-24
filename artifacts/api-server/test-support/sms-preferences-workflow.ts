/** Labeled fictional records, loopback PostgreSQL and provider I/O mocks ONLY. */
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  communicationsTable,
  closeWorkspaceConnections,
} from "@workspace/db";
import { inWorkspace, workspaceConfigs } from "@workspace/db/workspace";
import { hashPassword } from "../src/lib/auth";
import {
  recordSmsConsent,
  recheckSmsDispatch,
  authorizeSmsDispatch,
  currentSmsSenderBinding,
} from "../src/lib/sms-preferences";
import { smsSenderBinding } from "../src/lib/sms-permission-rules";
import app from "../src/app";
assert.equal(process.env.CATALYST_ISOLATED_TEST, "true");
assert.equal(workspaceConfigs.length, 2);
for (const workspace of workspaceConfigs) {
  const url = new URL(workspace.databaseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.pathname, /^\/sms_preferences_[a-f0-9]{32}_[ab]$/);
}
const checks: string[] = [],
  context = <T>(index: number, work: () => Promise<T>) =>
    inWorkspace(workspaceConfigs[index], work);
const password = "FICTIONAL-local-SMS-preference-password",
  project = "11111111-1111-1111-1111-111111111111",
  sender = "+15005550006",
  key = "SYNTHETIC-SIGNING-KEY";
const originalFetch = globalThis.fetch,
  messages = new Map<string, Record<string, string>>();
let providerSends = 0,
  providerLookups = 0,
  failTimestamp = false,
  ambiguous = false,
  onProviderRequest: (() => Promise<void>) | null = null;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, "fixture.signalwire.com");
  assert.equal(url.protocol, "https:");
  if (
    init?.method === "POST" &&
    url.pathname === `/api/laml/2010-04-01/Accounts/${project}/Messages`
  ) {
    providerSends++;
    const fields = new URLSearchParams(String(init.body));
    assert.equal(fields.get("From"), sender);
    if (onProviderRequest) {
      const fn = onProviderRequest;
      onProviderRequest = null;
      await fn();
    }
    if (ambiguous) throw new Error("Fictional provider transport uncertainty");
    return Response.json({
      sid: randomUUID(),
      from: sender,
      to: fields.get("To"),
      account_sid: project,
      status: "queued",
    });
  }
  assert.equal(init?.method, undefined);
  providerLookups++;
  if (failTimestamp) return new Response(null, { status: 503 });
  const record = messages.get(url.pathname.split("/").at(-1)!);
  assert.ok(record);
  return Response.json({
    ...record,
    direction: "inbound",
    date_created: new Date().toISOString(),
  });
};
type Actor = { host: string; cookie: string; csrf: string };
async function call(
  actor: Actor,
  method: string,
  path: string,
  data?: unknown,
  status = 200,
) {
  let req = (request(app) as any)
    [method.toLowerCase()]("/api" + path)
    .set("Host", actor.host)
    .set("Origin", "https://" + actor.host)
    .set("Cookie", actor.cookie);
  if (method !== "GET") req = req.set("x-csrf-token", actor.csrf);
  if (data !== undefined) req = req.send(data);
  const response = await req;
  assert.equal(
    response.status,
    status,
    JSON.stringify({ path, status: response.status, body: response.body }),
  );
  return response.body;
}
async function login(index: number, role: string): Promise<Actor> {
  const host = workspaceConfigs[index].host;
  const response = await request(app)
    .post("/api/auth/login")
    .set("Host", host)
    .set("Origin", "https://" + host)
    .send({ email: `${role}@fixture.example.invalid`, password });
  assert.equal(response.status, 200);
  return {
    host,
    cookie: response.headers["set-cookie"][0].split(";")[0],
    csrf: response.body.csrfToken,
  };
}
const read = (actor: Actor, to: string) =>
  call(actor, "GET", "/sms-preferences/recipient?to=" + encodeURIComponent(to));
const send = (
  actor: Actor,
  to: string,
  idempotencyKey = randomUUID(),
  status = 201,
) =>
  call(
    actor,
    "POST",
    "/communications/sms",
    { to, body: "FICTIONAL local provider mock workflow only", idempotencyKey },
    status,
  );
const consentInput = (
  preference: any,
  synthetic = false,
  releaseSuppression = false,
) => ({
  to: preference.to,
  revision: preference.revision,
  requestKey: randomUUID(),
  bindingFingerprint: preference.binding?.fingerprint ?? null,
  evidence: {
    source: "written",
    occurredAt: new Date().toISOString(),
    note: "FICTIONAL local fixture simulating owner evidence; no real permission",
    reference: "LOCAL MOCK ONLY",
    synthetic,
  },
  releaseSuppression,
});
async function inbound(
  actor: Actor,
  to: string,
  body: string,
  expected = 200,
  sid = randomUUID(),
  valid = true,
) {
  const path = "/api/communications/webhooks/signalwire/inbound";
  const fields = {
    AccountSid: project,
    MessageSid: sid,
    From: to,
    To: sender,
    Body: body,
    NumMedia: "0",
  };
  messages.set(sid, { account_sid: project, sid, from: to, to: sender, body });
  const signature = createHmac("sha1", key)
    .update(
      "https://" +
        actor.host +
        path +
        Object.keys(fields)
          .sort()
          .map((k) => k + fields[k as keyof typeof fields])
          .join(""),
    )
    .digest("base64");
  const response = await request(app)
    .post(path)
    .set("Host", actor.host)
    .set("x-signalwire-signature", valid ? signature : "INVALID")
    .type("form")
    .send(fields);
  assert.equal(response.status, expected);
  if (expected === 200) {
    assert.ok(response.text.includes("<Response></Response>"));
    assert.ok(!/<(?:Message|Sms)>/.test(response.text));
  }
  return sid;
}
async function eventCount(to: string) {
  return context(0, async () =>
    Number(
      (
        await pool.query(
          "SELECT count(*) AS n FROM sms_preference_events WHERE recipient=$1",
          [to],
        )
      ).rows[0].n,
    ),
  );
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
try {
  for (let i = 0; i < 2; i++)
    await context(i, async () => {
      for (const role of ["owner", "sales", "operations", "installer"] as const)
        await db
          .insert(usersTable)
          .values({
            id: role + "-fixture",
            email: `${role}@fixture.example.invalid`,
            name: "FICTIONAL " + role,
            role,
            active: true,
            passwordHash: await hashPassword(password),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
    });
  const owner = await login(0, "owner"),
    sales = await login(0, "sales"),
    operations = await login(0, "operations"),
    installer = await login(0, "installer"),
    other = await login(1, "owner");
  const to = "+15005550020";
  const initial = await read(owner, "(500) 555-0020");
  assert.equal(initial.to, to);
  assert.equal(initial.revision, 0);
  assert.equal(initial.permission.status, "unknown");
  const headers = await request(app)
    .get("/api/sms-preferences/recipient")
    .set("Host", owner.host)
    .set("Cookie", owner.cookie)
    .query({ to });
  assert.equal(headers.headers["cache-control"], "no-store");
  await call(
    installer,
    "GET",
    "/sms-preferences/recipient?to=" + encodeURIComponent(to),
    undefined,
    403,
  );
  await call(
    sales,
    "POST",
    "/sms-preferences/consent",
    consentInput(initial),
    403,
  );
  await request(app)
    .post("/api/sms-preferences/suppress")
    .set("Host", owner.host)
    .set("Origin", "https://" + owner.host)
    .set("Cookie", owner.cookie)
    .send({
      to,
      revision: 0,
      requestKey: randomUUID(),
      note: "Fictional optout",
    })
    .expect(403);
  await call(owner, "POST", "/auth/persona", { role: "sales" });
  await call(
    owner,
    "POST",
    "/sms-preferences/consent",
    consentInput(initial),
    403,
  );
  await call(
    owner,
    "POST",
    "/sms-preferences/suppress",
    { to, revision: 0, requestKey: randomUUID(), note: "Fictional optout" },
    403,
  );
  assert.equal(
    (await call(owner, "GET", "/communications/sms/status")).mode,
    "capture",
  );
  assert.equal((await send(owner, to)).status, "captured");
  assert.equal(providerSends, 0);
  await call(owner, "POST", "/auth/persona", { role: null });
  checks.push(
    "actual owner/effective role/CSRF/no-store boundaries and E164 normalization",
  );
  await send(owner, to, randomUUID(), 409);
  assert.equal(providerSends, 0);
  const testEvidence = consentInput(initial, true);
  const testOnly = await call(
    owner,
    "POST",
    "/sms-preferences/consent",
    testEvidence,
  );
  assert.equal(testOnly.permission.status, "test_only");
  await send(owner, to, randomUUID(), 409);
  assert.equal(providerSends, 0);
  checks.push(
    "missing and fictional evidence block real dispatch claims even with live provider config",
  );
  const positive = consentInput(testOnly);
  const concurrent = await Promise.all([
    call(owner, "POST", "/sms-preferences/consent", positive),
    call(owner, "POST", "/sms-preferences/consent", positive),
  ]);
  assert.equal(concurrent[0].revision, concurrent[1].revision);
  assert.equal(await eventCount(to), 2);
  await call(
    owner,
    "POST",
    "/sms-preferences/consent",
    {
      ...positive,
      evidence: { ...positive.evidence, note: "Changed fictional evidence" },
    },
    409,
  );
  checks.push(
    "same immutable owner request commits once concurrently and changed replay refuses",
  );
  const sendKey = randomUUID(),
    first = await send(owner, to, sendKey);
  assert.equal(first.status, "queued", JSON.stringify(first));
  assert.equal(providerSends, 1);
  assert.equal((await send(owner, to, sendKey, 200)).id, first.id);
  assert.equal(providerSends, 1);
  const saved = await context(
    0,
    async () =>
      (
        await db
          .select()
          .from(communicationsTable)
          .where(eq(communicationsTable.id, first.id))
      )[0],
  );
  assert.ok(saved.smsConsentEventId);
  assert.equal(saved.smsBindingFingerprint, concurrent[0].binding.fingerprint);
  assert.equal(saved.smsPermissionRevision, concurrent[0].revision);
  const bound = await context(0, async () => currentSmsSenderBinding());
  assert.ok(bound);
  for (const changed of [
    { sender: "+15005550009" },
    { project: "22222222-2222-2222-2222-222222222222" },
    { companyKey: "changed-company" },
  ]) {
    const next = smsSenderBinding({ ...bound, ...changed });
    assert.ok(next);
    await assert.rejects(
      context(0, () =>
        db.transaction((tx) => authorizeSmsDispatch(tx, to, next)),
      ),
      /sender or company connection changed/,
    );
  }
  assert.equal((await read(other, to)).permission.status, "unknown");
  await request(app)
    .get("/api/sms-preferences/recipient")
    .set("Host", other.host)
    .set("Cookie", owner.cookie)
    .query({ to })
    .expect(401);
  const otherPermission = await call(
    other,
    "POST",
    "/sms-preferences/consent",
    consentInput(await read(other, to)),
  );
  assert.notEqual(
    otherPermission.binding.fingerprint,
    concurrent[0].binding.fingerprint,
  );
  checks.push(
    "saved outbound claim captures exact permission; sender/project/company changes and tenant isolation never reuse positive evidence",
  );
  await inbound(owner, to, "START");
  assert.equal((await read(owner, to)).permission.status, "consented");
  await assert.rejects(
    context(0, () => recheckSmsDispatch(saved)),
    /changed after this dispatch/,
  );
  checks.push(
    "immediate pre-provider recheck refuses a preference version changed after claim",
  );
  const optedOut = await call(operations, "POST", "/sms-preferences/suppress", {
    to,
    revision: 0,
    requestKey: randomUUID(),
    note: "FICTIONAL phone optout; stale view must still block",
  });
  assert.equal(optedOut.permission.status, "suppressed");
  assert.equal(optedOut.permission.canDeviceShare, false);
  const countBefore = await eventCount(to);
  await inbound(owner, to, "START");
  assert.equal((await read(owner, to)).permission.status, "suppressed");
  await send(owner, to, randomUUID(), 409);
  assert.equal(providerSends, 1);
  const afterReplay = await call(
    owner,
    "POST",
    "/sms-preferences/consent",
    positive,
  );
  assert.equal(afterReplay.permission.status, "suppressed");
  assert.equal(await eventCount(to), countBefore + 1);
  checks.push(
    "stale manual optout still blocks, signed START cannot release it, and old consent replay never erases later suppression",
  );
  const stopSid = randomUUID();
  failTimestamp = true;
  await inbound(owner, to, "STOP", 503, stopSid);
  assert.equal((await read(owner, to)).permission.status, "suppressed");
  const pendingRevision = (await read(owner, to)).revision;
  failTimestamp = false;
  await inbound(owner, to, "STOP", 200, stopSid);
  assert.equal((await read(owner, to)).revision, pendingRevision);
  const beforeForged = await eventCount(to);
  await inbound(owner, to, "START", 401, randomUUID(), false);
  assert.equal(await eventCount(to), beforeForged);
  checks.push(
    "signed pending STOP suppresses before failed provider lookup, retries are once-only and forged START never changes history",
  );
  await pause();
  const renewed = consentInput(await read(owner, to), false, true);
  const released = await call(
    owner,
    "POST",
    "/sms-preferences/consent",
    renewed,
  );
  assert.equal(released.permission.status, "consented");
  await context(0, async () => {
    await assert.rejects(
      pool.query(
        "UPDATE sms_preference_events SET note='tampered' WHERE recipient=$1",
        [to],
      ),
      (error) => (error as any).code === "23514",
    );
    await assert.rejects(
      pool.query("DELETE FROM sms_preference_events WHERE recipient=$1", [to]),
      (error) => (error as any).code === "23514",
    );
  });
  checks.push(
    "only explicit owner renewed evidence releases optout and SQL history is immutable",
  );
  const beforeRace = await read(owner, to),
    raceInput = consentInput(beforeRace);
  const race = await Promise.all([
    request(app)
      .post("/api/sms-preferences/consent")
      .set("Host", owner.host)
      .set("Origin", "https://" + owner.host)
      .set("Cookie", owner.cookie)
      .set("x-csrf-token", owner.csrf)
      .send(raceInput),
    inbound(owner, to, "STOP"),
  ]);
  assert.ok([200, 409].includes(race[0].status));
  assert.equal((await read(owner, to)).permission.status, "suppressed");
  await context(0, async () => {
    await assert.rejects(
      pool.query(
        "UPDATE sms_recipient_preferences SET suppressed=false,revision=revision+1 WHERE recipient=$1",
        [to],
      ),
      (error) => (error as any).code === "23514",
    );
  });
  checks.push(
    "concurrent positive review never loses a newer signed STOP; raw state update cannot silently release suppression",
  );
  await pause();
  await call(
    owner,
    "POST",
    "/sms-preferences/consent",
    consentInput(await read(owner, to), false, true),
  );
  const beforeFlight = providerSends;
  onProviderRequest = async () => {
    await call(sales, "POST", "/sms-preferences/suppress", {
      to,
      revision: 0,
      requestKey: randomUUID(),
      note: "FICTIONAL optout while provider request is in flight",
    });
  };
  const inFlightResult = await send(owner, to);
  assert.equal(inFlightResult.status, "queued", JSON.stringify(inFlightResult));
  assert.equal(providerSends, beforeFlight + 1);
  await send(owner, to, randomUUID(), 409);
  assert.equal(providerSends, beforeFlight + 1);
  checks.push(
    "an already in-flight provider request cannot be recalled but committed optout blocks every new claim",
  );
  await pause();
  await call(
    owner,
    "POST",
    "/sms-preferences/consent",
    consentInput(await read(owner, to), false, true),
  );
  ambiguous = true;
  const uncertainKey = randomUUID(),
    uncertain = await send(owner, to, uncertainKey);
  assert.equal(uncertain.status, "unknown");
  const attempts = providerSends;
  assert.equal((await send(owner, to, uncertainKey, 200)).id, uncertain.id);
  assert.equal(providerSends, attempts);
  ambiguous = false;
  checks.push(
    "ambiguous provider submission remains unknown with the same durable claim and never blind retries",
  );
  const legacy = await read(owner, "+15005550001");
  assert.equal(legacy.permission.status, "suppressed");
  assert.equal(legacy.history[0].kind, "legacy_stop");
  checks.push(
    "legacy pending STOP is retained company-wide and a historical START does not invent initial permission",
  );
  const oldRecipient = "+15005550030";
  await context(0, async () => {
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) n FROM sms_recipient_preferences WHERE recipient=$1",
            [oldRecipient],
          )
        ).rows[0].n,
      ),
      0,
    );
    await pool.query(
      "INSERT INTO communications(id,channel,direction,status,from_address,to_address,subject,body,provider_message_id,created_at) VALUES('late-legacy-stop','sms','inbound','received',$1,'+15005550009','SMS opt-out pending provider timestamp','STOP','signalwire:22222222-2222-2222-2222-222222222222:old-sender-stop','2026-11-23T10:00:00Z')",
      [oldRecipient],
    );
  });
  const oldPreference = await read(owner, oldRecipient);
  assert.equal(oldPreference.permission.status, "suppressed");
  assert.equal(oldPreference.permission.canDeviceShare, false);
  assert.ok(
    oldPreference.history.some((event: any) => event.kind === "legacy_stop"),
  );
  const beforeLate = providerSends;
  await context(0, () =>
    pool.query(
      "INSERT INTO communications(id,channel,direction,status,from_address,to_address,subject,body,provider_message_id,created_at) VALUES('late-active-stop','sms','inbound','received',$1,'+15005550009','SMS opt-out','STOP','signalwire:22222222-2222-2222-2222-222222222222:old-active-stop','2026-11-23T10:00:00Z')",
      [to],
    ),
  );
  await send(owner, to, randomUUID(), 409);
  assert.equal(providerSends, beforeLate);
  assert.equal((await read(owner, to)).permission.status, "suppressed");
  checks.push(
    "retained STOP without any preference row and after sender/project changes blocks lookup shortcuts and dispatch before provider calls",
  );
  // Direct helper authorization also rechecks current persisted staff role.
  await context(0, async () => {
    await db
      .update(usersTable)
      .set({ role: "sales" })
      .where(eq(usersTable.id, "owner-fixture"));
  });
  await assert.rejects(
    context(0, () => recordSmsConsent("owner-fixture", consentInput(released))),
    /current staff role/,
  );
  checks.push(
    "concurrent staff demotion cannot bypass owner-only evidence changes",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      providerMockSubmissions: providerSends,
      providerMockTimestampLookups: providerLookups,
      externalProviderRequests: 0,
      realConsentRecorded: false,
    }),
  );
  console.log("SMS preference actual PostgreSQL workflow passed");
} finally {
  globalThis.fetch = originalFetch;
  await closeWorkspaceConnections();
}
