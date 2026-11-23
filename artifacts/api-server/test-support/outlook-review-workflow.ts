/** Disposable PostgreSQL/Graph simulator. Never included in production build. */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool, crewsTable, crewBookingsTable, outlookBookingSyncTable, outlookBookingReviewsTable, outlookCalendarConnectionTable, jobsTable } from "@workspace/db";
import { listOutlookBookingReviews, processOutlookBookingQueue, resolveOutlookBookingReview } from "../src/lib/outlook-calendar";
import { getOutlookConfig, sealOutlookSecret } from "../src/lib/outlook-graph";

const url = new URL(process.env.DATABASE_URL!);
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && /^\/catalyst_release_/.test(url.pathname), "Outlook verification refuses non-disposable databases");
const config = getOutlookConfig()!;
assert.ok(config);
const crewId = "outlook-review-fixture-crew", bookingId = "outlook-review-fixture-booking", collisionId = "outlook-review-fixture-collision";
const calendarId = "outlook-review-fixture-calendar";
const events = new Map<string, any>();
let serial = 0, writes = 0, denied = false, offline = false, calendarMissing = false, concurrent = false;
let lastPatch: Record<string, unknown> | null = null, lastIfMatch: string | null = null;
const at = (hour: number) => `2026-11-02T${String(hour).padStart(2, "0")}:00:00.000Z`;
const rawAt = (date: string) => ({ dateTime: new Date(date).toISOString().slice(0, -1), timeZone: "UTC" });
function bump(event: any) { serial++; event.changeKey = `version-${serial}`; event["@odata.etag"] = `W/"version-${serial}"`; }
function edit(event: any, hour: number) { event.start = rawAt(at(hour)); event.end = rawAt(at(hour + 1)); bump(event); }
globalThis.fetch = (async (input: any, options: RequestInit = {}) => {
  const request = new URL(String(input));
  assert.equal(request.origin, "https://graph.microsoft.com", "Simulator refuses every external host");
  if (offline) throw new Error("Simulated unavailable provider");
  if (denied) return new Response(null, { status: 403 });
  const method = options.method ?? "GET";
  if (!request.pathname.includes("/events")) return calendarMissing ? new Response(null, { status: 404 }) : Response.json({ id: calendarId, name: "Internal fixture", canEdit: true });
  const eventId = decodeURIComponent(request.pathname.split("/events/")[1] ?? "");
  if (!eventId && method === "GET") return Response.json({ value: [...events.values()].filter((event) => (request.searchParams.get("$filter") ?? "").includes(event.key)).map(({ id }) => ({ id })) });
  if (!eventId && method === "POST") {
    const body = JSON.parse(String(options.body));
    const event = { ...body, id: `fixture-event-${serial + 1}`, key: body.transactionId, isCancelled: false, isAllDay: false, type: "singleInstance" };
    bump(event); events.set(event.id, event); writes++;
    return Response.json(event, { status: 201 });
  }
  const event = events.get(eventId);
  if (!event) return new Response(null, { status: 404 });
  if (method === "GET") return Response.json(event);
  if (concurrent) { concurrent = false; edit(event, 17); }
  lastIfMatch = new Headers(options.headers).get("If-Match");
  assert.ok(lastIfMatch, "Every Graph update/delete must use the actual etag");
  if (lastIfMatch !== event["@odata.etag"]) return new Response(null, { status: 412 });
  if (method === "DELETE") { writes++; events.delete(eventId); return new Response(null, { status: 204 }); }
  assert.equal(method, "PATCH"); lastPatch = JSON.parse(String(options.body));
  Object.assign(event, lastPatch); bump(event); writes++;
  return Response.json(event);
}) as typeof fetch;

const readBooking = async () => (await db.select().from(crewBookingsTable).where(eq(crewBookingsTable.id, bookingId)))[0];
const readSync = async () => (await db.select().from(outlookBookingSyncTable).where(eq(outlookBookingSyncTable.bookingId, bookingId)))[0];
const poll = async () => { await db.update(outlookBookingSyncTable).set({ externalCheckedAt: null, retryAt: null }).where(eq(outlookBookingSyncTable.bookingId, bookingId)); await processOutlookBookingQueue(); };
const review = async () => (await listOutlookBookingReviews()).reviews.find((row) => row.bookingId === bookingId)!;
const resolve = async (row: Awaited<ReturnType<typeof review>>, action: "use_outlook" | "reapply_local") => resolveOutlookBookingReview(bookingId, { bookingRevision: row.bookingRevision, reviewRevision: row.reviewRevision, action, note: "Explicit isolated owner review" }, "release-owner");
try {
  assert.equal((await db.select().from(outlookCalendarConnectionTable)).length, 0);
  const now = new Date().toISOString();
  await db.insert(crewsTable).values({ id: crewId, name: "Outlook review crew", timezone: "UTC", size: 2, dailyCapacityHours: 8, workingDays: [0,1,2,3,4,5,6], createdAt: now, updatedAt: now });
  for (const [id, hour] of [[bookingId, 13], [collisionId, 14]] as const) await db.insert(crewBookingsTable).values({ id, crewId, jobId: "other-job", startAt: at(hour), endAt: at(hour + 1), plannedLaborHours: 1, createdAt: now, updatedAt: now });
  await db.insert(outlookCalendarConnectionTable).values({ id: 1, accountId: "fixture-account", accountName: "Internal fixture", status: "connected", calendarId,
    accessToken: sealOutlookSecret(config, "fake-access-token", "access:fixture-account"), refreshToken: sealOutlookSecret(config, "fake-refresh-token", "refresh:fixture-account"),
    accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(), updatedAt: now });
  await db.insert(outlookBookingSyncTable).values({ bookingId, accountId: "fixture-account", calendarId, updatedAt: now });
  await poll();
  let sync = await readSync(), event = events.get(sync.eventId!)!;
  assert.equal(sync.syncedRevision, 1); assert.equal(sync.externalSnapshot!.etag, event["@odata.etag"]); assert.equal(writes, 1);

  edit(event, 14); await poll();
  let row = await review(); assert.equal(row.kind, "edited"); assert.equal((await readBooking()).startAt, at(13)); assert.equal(writes, 1);
  await assert.rejects(resolve(row, "use_outlook"), /overlapping/);
  await assert.rejects(resolveOutlookBookingReview(bookingId, { bookingRevision: 99, reviewRevision: row.reviewRevision, action: "use_outlook", note: "Stale booking" }, "release-owner"), /changed/);
  assert.equal((await review()).reviewRevision, row.reviewRevision);
  edit(event, 15);
  await assert.rejects(resolve(row, "use_outlook"), /changed again/);
  row = await review(); assert.ok(row.reviewRevision > 1);
  await resolve(row, "use_outlook");
  assert.equal((await readBooking()).startAt, at(15)); assert.equal((await readSync()).syncedRevision, 2);
  await resolve(row, "use_outlook"); // Idempotent resolution does not update twice.
  assert.equal((await readBooking()).revision, 2);

  event.subject = "Outlook title retained"; event.body = { contentType: "html", content: "External notes and meeting link" }; edit(event, 16); await poll();
  row = await review(); concurrent = true;
  await assert.rejects(resolve(row, "reapply_local"), /changed while saving/);
  assert.equal(event.start.dateTime, rawAt(at(17)).dateTime); assert.equal((await readBooking()).startAt, at(15));
  row = await review(); await resolve(row, "reapply_local");
  assert.equal(event.start.dateTime, rawAt(at(15)).dateTime); assert.deepEqual(Object.keys(lastPatch!).sort(), ["end", "start"]);
  assert.equal(event.subject, "Outlook title retained"); assert.equal(event.body.content, "External notes and meeting link");
  assert.ok(lastIfMatch);

  // A local edit still uses conditional, schedule-only writes after acceptance.
  await db.update(crewBookingsTable).set({ startAt: at(18), endAt: at(19), revision: 3 }).where(eq(crewBookingsTable.id, bookingId));
  await poll(); assert.equal(event.start.dateTime, rawAt(at(18)).dateTime); assert.equal(event.subject, "Outlook title retained");
  denied = true; await poll(); denied = false;
  assert.equal(await review(), undefined); assert.match((await readSync()).lastError!, /denied/);
  await poll(); assert.equal((await readSync()).lastError, null);
  offline = true; await poll(); offline = false;
  assert.equal(await review(), undefined); assert.equal((await readBooking()).status, "Confirmed");
  const deletedId = (await readSync()).eventId!; events.delete(deletedId); calendarMissing = true; await poll(); calendarMissing = false;
  assert.equal(await review(), undefined, "A missing calendar is not an individual deletion");
  await poll(); row = await review(); assert.equal(row.kind, "deleted"); assert.equal(row.remote, null);
  denied = true; await assert.rejects(resolve(row, "use_outlook"), /denied/); denied = false;
  assert.equal((await readBooking()).status, "Confirmed");
  const jobBefore = (await db.select().from(jobsTable).where(eq(jobsTable.id, "other-job")))[0];
  await resolve(row, "use_outlook");
  assert.equal((await readBooking()).status, "Cancelled"); assert.equal((await readSync()).eventId, null);
  assert.deepEqual((await db.select().from(jobsTable).where(eq(jobsTable.id, "other-job")))[0], jobBefore);
  console.log("Outlook review PostgreSQL/Graph simulation passed: edit, overlap, stale revision, conditional412, metadata preservation, provider denial, deletion, cancellation and replay");
} finally {
  await db.delete(outlookBookingReviewsTable).where(eq(outlookBookingReviewsTable.bookingId, bookingId));
  await db.delete(outlookBookingSyncTable).where(eq(outlookBookingSyncTable.bookingId, bookingId));
  await db.delete(crewBookingsTable).where(eq(crewBookingsTable.crewId, crewId));
  await db.delete(crewsTable).where(eq(crewsTable.id, crewId));
  await db.delete(outlookCalendarConnectionTable).where(eq(outlookCalendarConnectionTable.accountId, "fixture-account"));
  await pool.end();
}
