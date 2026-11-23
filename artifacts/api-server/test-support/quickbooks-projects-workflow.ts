/** Real disposable PostgreSQL + normal Projects router. Intuit HTTPS is simulated;
 * no real company, authorization service or financial transaction is contacted. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  jobsTable,
  quickbooksConnectionsTable as connections,
  quickbooksEntityMappingsTable as mappings,
  quickbooksProjectLinksTable as links,
  quickbooksProjectReviewsTable as reviews,
} from "@workspace/db";
import router from "../src/routes/quickbooks-projects";
import quickbooksRouter from "../src/routes/quickbooks";
import {
  accountingScope,
  encryptSecret,
  projectsScope,
} from "../src/lib/quickbooks";
import { verifiedProjectForJob } from "../src/lib/quickbooks-projects";

const url = new URL(process.env.DATABASE_URL!);
assert.ok(
  ["127.0.0.1", "localhost"].includes(url.hostname) &&
    /^\/catalyst_release_/.test(url.pathname),
  "Projects fixtures refuse every non-disposable database",
);
const marker = randomUUID();
let connectionId = `projects-${marker}`;
const jobIds = [
  `projects-a-${marker}`,
  `projects-b-${marker}`,
  `projects-c-${marker}`,
];
let preference = true,
  probeErrors = false,
  loseResponse = true,
  refuseCreate = false,
  mutationCount = 0;
let tokenExchanges = 0,
  returnedScope: string | undefined;
const remote = new Map<string, any>();
const rawNode = (
  id: string,
  customerId = "007",
  name = "Existing fixture Project",
) => ({
  id,
  name,
  description: "Existing real-provider-format fixture",
  status: "OPEN",
  customer: { id: customerId },
});
remote.set("foreign-project", rawNode("foreign-project", "999"));
remote.set("000-existing", rawNode("000-existing"));
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, options: RequestInit = {}) => {
  const target = new URL(String(input));
  if (target.origin === "https://oauth.platform.intuit.com") {
    tokenExchanges++;
    assert.equal(
      (options.body as URLSearchParams).get("grant_type"),
      "authorization_code",
    );
    return Response.json({
      access_token: "synthetic-exchanged-access",
      refresh_token: "synthetic-exchanged-refresh",
      expires_in: 3600,
      x_refresh_token_expires_in: 86400,
      ...(returnedScope === undefined ? {} : { scope: returnedScope }),
    });
  }
  if (target.origin === "https://sandbox-quickbooks.api.intuit.com") {
    assert.equal(
      options.method ?? "GET",
      "GET",
      "Projects reads must not create REST subcustomers",
    );
    assert.match(target.pathname, /^\/v3\/company\/123\//);
    if (target.pathname.endsWith("/preferences"))
      return Response.json({
        Preferences: {
          OtherPrefs: {
            NameValue: [{ Name: "ProjectsEnabled", Value: String(preference) }],
          },
        },
      });
    if (target.pathname.endsWith("/customer/007"))
      return Response.json({
        Customer: {
          Id: "007",
          Active: true,
          DisplayName: "Verified fixture customer",
          Job: false,
        },
      });
    throw new Error("Unexpected accounting read");
  }
  assert.equal(
    target.origin,
    "https://qb-sandbox.api.intuit.com",
    "Provider requests stay on the actual saved company's fixed sandbox host",
  );
  const payload = JSON.parse(String(options.body));
  if (probeErrors)
    return Response.json({
      data: { projectManagementProjects: {} },
      errors: [{ message: "Entitlement unavailable" }],
    });
  if (payload.query.startsWith("mutation ")) {
    mutationCount++;
    if (refuseCreate) return new Response(null, { status: 403 });
    const project = {
      id: `000-created-${mutationCount}`,
      name: payload.variables.name,
      description: payload.variables.description,
      status: "OPEN",
      customer: { id: payload.variables.customer.id },
    };
    remote.set(project.id, project);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("Response lost after provider accepted creation");
    }
    return Response.json({ data: { projectManagementCreateProject: project } });
  }
  if (payload.variables.id)
    return Response.json({
      data: {
        projectManagementProject: remote.get(payload.variables.id) ?? null,
      },
    });
  return Response.json({
    data: {
      projectManagementProjects: {
        edges: [...remote.values()].map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  });
}) as typeof fetch;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => {
  const role = req.get("x-fixture-role") === "sales" ? "sales" : "owner";
  req.auth = {
    userId: "projects-fixture-owner",
    email: "fixture@example.invalid",
    name: "Fixture owner",
    role,
    actualRole: role,
    previewRole: null,
    csrfToken: "fixture",
  };
  req.log = { error: () => {} } as any;
  next();
});
app.use(router);
app.use(quickbooksRouter);
const path = (id = jobIds[0]) => `/quickbooks/projects/jobs/${id}`;
const call = async (
  method: "get" | "post" | "put",
  route: string,
  body?: unknown,
  status = 200,
) => {
  const result = await request(app)[method](route).send(body);
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
};
const createdAt = new Date().toISOString();
const originalConnections = await db.select().from(connections);
assert.equal(
  originalConnections.length,
  0,
  "The preceding fixture must restore its QuickBooks connection before Projects tests",
);
try {
  const [source] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, "other-job"));
  for (const [index, id] of jobIds.entries())
    await db.insert(jobsTable).values({
      ...source,
      id,
      jobNumber: `PROJECTS-${index}-${marker.slice(0, 8)}`,
      shareToken: randomUUID(),
    });
  await db.insert(connections).values({
    id: connectionId,
    realmId: "123",
    companyName: "Actual-format fixture company",
    environment: "sandbox",
    grantedScopes: [accountingScope, projectsScope],
    encryptedAccessToken: encryptSecret("synthetic-only-projects-access"),
    encryptedRefreshToken: encryptSecret("synthetic-only-projects-refresh"),
    accessTokenExpiresAt: "2099-01-01",
    refreshTokenExpiresAt: "2099-01-01",
    status: "connected",
    createdAt,
    updatedAt: createdAt,
  });
  for (const id of jobIds)
    await db.insert(mappings).values({
      id: randomUUID(),
      entityType: "customer",
      localId: id,
      quickbooksId: "007",
      realmId: "123",
      environment: "sandbox",
      createdAt,
      updatedAt: createdAt,
    });
  await db.insert(mappings).values({
    id: randomUUID(),
    entityType: "project",
    localId: jobIds[0],
    quickbooksId: "legacy-child-customer",
    realmId: "123",
    environment: "sandbox",
    createdAt,
    updatedAt: createdAt,
  });

  assert.equal(
    (
      await request(app)
        .get("/quickbooks/projects/capability")
        .set("x-fixture-role", "sales")
    ).status,
    403,
  );
  assert.equal(
    (await call("get", "/quickbooks/projects/capability")).available,
    true,
  );
  assert.equal(
    (await call("get", "/quickbooks/status")).projects.verified,
    true,
  );
  preference = false;
  assert.equal(
    (await call("get", "/quickbooks/status")).projects.verified,
    false,
  );
  assert.equal(
    (await call("get", "/quickbooks/projects/capability")).available,
    false,
  );
  preference = true;
  probeErrors = true;
  assert.equal(
    (await call("get", "/quickbooks/projects/capability")).available,
    false,
  );
  probeErrors = false;
  await db
    .update(connections)
    .set({ grantedScopes: [accountingScope] })
    .where(eq(connections.id, connectionId));
  assert.equal(
    (await call("get", "/quickbooks/projects/capability")).scopeGranted,
    false,
  );
  await db
    .update(connections)
    .set({ grantedScopes: [accountingScope, projectsScope] })
    .where(eq(connections.id, connectionId));
  const state = await call("get", path());
  assert.equal(state.link, null);
  assert.equal(state.legacySubcustomer.id, "legacy-child-customer");
  const candidates = await call(
    "get",
    `${path()}/candidates?connectionId=${connectionId}`,
  );
  assert.deepEqual(
    candidates.projects.map((p: any) => p.id),
    ["000-existing"],
  );
  await call(
    "put",
    `${path()}/link`,
    {
      connectionId,
      jobRevision: state.job.revision,
      projectId: "foreign-project",
      note: "Reject foreign customer",
    },
    409,
  );

  const review = await call("post", `${path()}/create-review`, {
    connectionId,
    jobRevision: state.job.revision,
    name: "Owner reviewed replacement",
    description: "Explicitly reviewed fixture description",
  });
  assert.match(
    review.description,
    new RegExp(`Catalyst Works project reference ${review.id}`),
  );
  const approval = {
    connectionId,
    reviewRevision: review.revision,
    fingerprint: review.fingerprint,
    note: "Owner approves these exact fixture details",
  };
  const concurrent = await Promise.all([
    request(app)
      .post(`/quickbooks/projects/reviews/${review.id}/submit`)
      .send(approval),
    request(app)
      .post(`/quickbooks/projects/reviews/${review.id}/submit`)
      .send(approval),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  assert.equal(mutationCount, 1);
  const unknown = concurrent.find((r) => r.status === 200)!.body.review;
  assert.equal(unknown.status, "unknown");
  assert.ok(unknown.submittedAt);
  await call(
    "post",
    `/quickbooks/projects/reviews/${review.id}/submit`,
    { ...approval, reviewRevision: unknown.revision },
    409,
  );
  await call(
    "post",
    `${path()}/create-review`,
    {
      connectionId,
      jobRevision: state.job.revision,
      name: "Do not duplicate",
      description: "",
    },
    409,
  );
  assert.equal(mutationCount, 1);
  // Actual OAuth route: omitted scope comes only from the successful exchange's
  // signed request, and reconnecting cannot hide a prior uncertain creation.
  const consent = await call("get", "/quickbooks/connect?projects=true");
  const signedState = new URL(consent.authorizationUrl).searchParams.get(
    "state",
  )!;
  assert.equal(
    new URL(consent.authorizationUrl).searchParams.get("scope"),
    `${accountingScope} ${projectsScope}`,
  );
  const callback = () =>
    request(app)
      .get("/quickbooks/callback")
      .query({ state: signedState, code: "synthetic-code", realmId: "123" })
      .set("Cookie", `qbo_oauth_state=${encodeURIComponent(signedState)}`);
  assert.equal((await callback()).status, 302);
  assert.equal(tokenExchanges, 1);
  assert.equal((await callback()).status, 400);
  assert.equal(tokenExchanges, 1);
  const [reconnected] = await db.select().from(connections);
  connectionId = reconnected.id;
  assert.deepEqual(reconnected.grantedScopes, [accountingScope, projectsScope]);
  const afterReconnect = await call("get", path());
  assert.equal(afterReconnect.review.id, review.id);
  assert.equal(afterReconnect.review.status, "unknown");
  await call(
    "post",
    `${path()}/create-review`,
    {
      connectionId,
      jobRevision: state.job.revision,
      name: "Do not duplicate after reconnect",
      description: "",
    },
    409,
  );
  assert.equal(mutationCount, 1);
  const recovered = await call(
    "post",
    `/quickbooks/projects/reviews/${review.id}/reconcile`,
    { connectionId, reviewRevision: unknown.revision },
  );
  assert.equal(recovered.review.status, "linked");
  assert.equal(recovered.link.projectId, "000-created-1");
  assert.equal(mutationCount, 1);
  const [connection] = await db.select().from(connections);
  assert.equal(
    (await verifiedProjectForJob(jobIds[0], "007", connection))!.projectId,
    "000-created-1",
  );
  assert.equal(
    await verifiedProjectForJob(jobIds[1], "007", connection),
    null,
    "Legacy subcustomers never become true Projects",
  );
  await assert.rejects(
    verifiedProjectForJob(jobIds[0], "999", connection),
    /different customer/,
  );
  const second = await call("get", path(jobIds[1]));
  await call(
    "put",
    `${path(jobIds[1])}/link`,
    {
      connectionId,
      jobRevision: second.job.revision,
      projectId: recovered.link.projectId,
      note: "Reject sharing the Project between jobs",
    },
    409,
  );
  remote.get("000-created-1").name = "Edited externally";
  await assert.rejects(
    verifiedProjectForJob(jobIds[0], "007", connection),
    /changed since/,
  );

  const stale = await call("post", `${path(jobIds[1])}/create-review`, {
    connectionId,
    jobRevision: second.job.revision,
    name: "Stale job fixture",
    description: "",
  });
  await db
    .update(jobsTable)
    .set({
      revision: second.job.revision + 1,
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    })
    .where(eq(jobsTable.id, jobIds[1]));
  await call(
    "post",
    `/quickbooks/projects/reviews/${stale.id}/submit`,
    {
      connectionId,
      reviewRevision: stale.revision,
      fingerprint: stale.fingerprint,
      note: "Refuse stale job",
    },
    409,
  );
  assert.equal(mutationCount, 1);
  const third = await call("get", path(jobIds[2]));
  const rejected = await call("post", `${path(jobIds[2])}/create-review`, {
    connectionId,
    jobRevision: third.job.revision,
    name: "Definitive rejection fixture",
    description: "",
  });
  refuseCreate = true;
  const failed = await call(
    "post",
    `/quickbooks/projects/reviews/${rejected.id}/submit`,
    {
      connectionId,
      reviewRevision: rejected.revision,
      fingerprint: rejected.fingerprint,
      note: "Test provider rejection",
    },
  );
  assert.equal(failed.review.status, "failed");
  assert.equal(mutationCount, 2);
  await call(
    "post",
    `/quickbooks/projects/reviews/${rejected.id}/submit`,
    {
      connectionId,
      reviewRevision: failed.review.revision,
      fingerprint: rejected.fingerprint,
      note: "Never duplicate",
    },
    409,
  );
  assert.equal(mutationCount, 2);
  const reducedConsent = await call("get", "/quickbooks/connect?projects=true");
  const reducedState = new URL(
    reducedConsent.authorizationUrl,
  ).searchParams.get("state")!;
  returnedScope = accountingScope;
  const tampered = await request(app)
    .get("/quickbooks/callback")
    .query({
      state: `${reducedState}tampered`,
      code: "synthetic-code",
      realmId: "123",
    })
    .set(
      "Cookie",
      `qbo_oauth_state=${encodeURIComponent(`${reducedState}tampered`)}`,
    );
  assert.equal(tampered.status, 400);
  assert.equal(tokenExchanges, 1);
  const reduced = await request(app)
    .get("/quickbooks/callback")
    .query({ state: reducedState, code: "synthetic-code", realmId: "123" })
    .set("Cookie", `qbo_oauth_state=${encodeURIComponent(reducedState)}`);
  assert.equal(reduced.status, 302);
  assert.equal(tokenExchanges, 2);
  const [reducedConnection] = await db.select().from(connections);
  connectionId = reducedConnection.id;
  assert.deepEqual(reducedConnection.grantedScopes, [accountingScope]);
  assert.equal(
    (await call("get", "/quickbooks/projects/capability")).available,
    false,
  );
  assert.equal(
    (
      await db
        .select()
        .from(mappings)
        .where(
          and(
            eq(mappings.entityType, "project"),
            eq(mappings.localId, jobIds[0]),
          ),
        )
    )[0].quickbooksId,
    "legacy-child-customer",
  );
  console.log("True Projects PostgreSQL/router/GraphQL simulation passed");
} finally {
  globalThis.fetch = originalFetch;
  await db.delete(links).where(inArray(links.jobId, jobIds));
  await db.delete(reviews).where(inArray(reviews.jobId, jobIds));
  await db.delete(mappings).where(inArray(mappings.localId, jobIds));
  await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  await db.delete(connections).where(eq(connections.id, connectionId));
  await pool.end();
}
