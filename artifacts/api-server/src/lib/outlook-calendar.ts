import { workspaceScopeKey } from "@workspace/db/workspace";
import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  crewBookingsTable,
  crewsTable,
  db,
  jobsTable,
  outlookBookingSyncTable,
  outlookBookingReviewsTable,
  outlookCalendarConnectionTable,
  tasksTable,
  withWorkspaceConnection,
} from "@workspace/db";
import { DomainError } from "./operations-rules";
import { z } from "zod";
import {
  fetchOutlookToken,
  getOutlookConfig,
  hasOutlookMailScope,
  normalizeOutlookScopes,
  openOutlookSecret,
  OutlookError,
  outlookGraph,
  reconcileOutlookInstallation,
  sealOutlookSecret,
  type OutlookConfig,
} from "./outlook-graph";
import { logger } from "./logger";
import { audit } from "./auth";
import { assertRevision } from "./operations-rules";
import { assertCrewBookingAvailability } from "./booking-availability";
import { acceptedOutlookSchedule, detectOutlookReview, matchesLocalOutlookSchedule, sameOutlookVersion, type OutlookEventSnapshot, type OutlookReviewKind } from "./outlook-review";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Connection = typeof outlookCalendarConnectionTable.$inferSelect;
type Graph = ReturnType<typeof outlookGraph>;
const connectionId = 1;
const nowIso = () => new Date().toISOString();
const connectionKey = (accountId: string, purpose: "access" | "refresh") =>
  `${purpose}:${accountId}`;

async function getConnection(query: Pick<Transaction, "select"> = db) {
  const [connection] = await query
    .select()
    .from(outlookCalendarConnectionTable)
    .where(eq(outlookCalendarConnectionTable.id, connectionId));
  return connection;
}

function serialOutlook<T>(action: (tx: Transaction) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('catalyst:outlook-calendar'))`,
    );
    return action(tx);
  });
}

async function accessToken(
  tx: Transaction,
  config: OutlookConfig,
  connection: Connection,
  forceRefresh: boolean,
) {
  if (
    !connection.accessToken ||
    !connection.refreshToken ||
    connection.status !== "connected"
  ) {
    throw new OutlookError(
      "Connect Outlook in Settings before syncing bookings.",
      409,
    );
  }
  if (
    !forceRefresh &&
    Date.parse(connection.accessTokenExpiresAt ?? "") > Date.now() + 120_000
  ) {
    return {
      token: openOutlookSecret(
        config,
        connection.accessToken,
        connectionKey(connection.accountId, "access"),
      ),
      grantedScopes: connection.grantedScopes,
    };
  }
  const refresh = openOutlookSecret(
    config,
    connection.refreshToken,
    connectionKey(connection.accountId, "refresh"),
  );
  // Refresh only scopes actually granted by Microsoft. Legacy calendar-only rows
  // have no recorded scopes and must never silently acquire Mail.Send.
  const scope = connection.grantedScopes
    ? normalizeOutlookScopes(`${connection.grantedScopes} offline_access`)
    : config.scope;
  const tokens = await fetchOutlookToken(config, {
    refreshToken: refresh,
    scope,
  });
  const grantedScopes =
    tokens.scope === undefined
      ? connection.grantedScopes
      : normalizeOutlookScopes(tokens.scope);
  await tx
    .update(outlookCalendarConnectionTable)
    .set({
      accessToken: sealOutlookSecret(
        config,
        tokens.access_token,
        connectionKey(connection.accountId, "access"),
      ),
      refreshToken: tokens.refresh_token
        ? sealOutlookSecret(
            config,
            tokens.refresh_token,
            connectionKey(connection.accountId, "refresh"),
          )
        : connection.refreshToken,
      accessTokenExpiresAt: new Date(
        Date.now() + tokens.expires_in * 1000,
      ).toISOString(),
      grantedScopes,
      updatedAt: nowIso(),
    })
    .where(eq(outlookCalendarConnectionTable.id, connectionId));
  return { token: tokens.access_token, grantedScopes };
}

async function withGraph<T>(
  tx: Transaction,
  config: OutlookConfig,
  connection: Connection,
  action: (graph: Graph, grantedScopes: string) => Promise<T>,
) {
  const token = await accessToken(tx, config, connection, false);
  try {
    return await action(outlookGraph(token.token), token.grantedScopes);
  } catch (error) {
    if (!(error instanceof OutlookError) || error.status !== 401) throw error;
    const [fresh] = await tx
      .select()
      .from(outlookCalendarConnectionTable)
      .where(eq(outlookCalendarConnectionTable.id, connectionId));
    const refreshed = await accessToken(tx, config, fresh ?? connection, true);
    return action(outlookGraph(refreshed.token), refreshed.grantedScopes);
  }
}

const markReconnect = (tx: Transaction) =>
  tx
    .update(outlookCalendarConnectionTable)
    .set({ status: "reconnect_required", updatedAt: nowIso() })
    .where(eq(outlookCalendarConnectionTable.id, connectionId));

function requireConfig() {
  const config = getOutlookConfig();
  if (!config)
    throw new DomainError(503, "Outlook is not configured on this server.");
  return config;
}

function errorMessage(error: unknown) {
  if (error instanceof OutlookError) return error.message;
  logger.error("Outlook calendar operation failed");
  return "Catalyst could not sync this Outlook booking. Check the connection in Settings.";
}

export async function finishOutlookConnection(
  config: OutlookConfig,
  code: string,
  verifier: string,
  scope = config.scope,
) {
  const tokens = await fetchOutlookToken(config, { code, verifier, scope });
  if (!tokens.refresh_token)
    throw new OutlookError(
      "Microsoft did not grant offline access. Reconnect and grant calendar permissions.",
    );
  const account = await outlookGraph(tokens.access_token).account();
  await serialOutlook(async (tx) => {
    const current = await getConnection(tx);
    const sameAccount = current?.accountId === account.id;
    if (current && !sameAccount) {
      const [tracked] = await tx
        .select({ id: outlookBookingSyncTable.bookingId })
        .from(outlookBookingSyncTable)
        .innerJoin(
          crewBookingsTable,
          eq(crewBookingsTable.id, outlookBookingSyncTable.bookingId),
        )
        .where(
          and(
            eq(outlookBookingSyncTable.accountId, current.accountId),
            or(
              isNotNull(outlookBookingSyncTable.eventId),
              gt(
                crewBookingsTable.revision,
                outlookBookingSyncTable.syncedRevision,
              ),
            ),
          ),
        )
        .limit(1);
      if (tracked)
        throw new OutlookError(
          "Reconnect the Microsoft account that owns the previously synced bookings.",
          409,
        );
    }
    const fields = {
      accountId: account.id,
      accountName:
        account.displayName || account.userPrincipalName || "Microsoft account",
      mailboxEmail:
        [account.mail, account.userPrincipalName]
          .map((value) => z.string().email().safeParse(value))
          .find((result) => result.success)?.data ?? null,
      grantedScopes: normalizeOutlookScopes(tokens.scope),
      accessToken: sealOutlookSecret(
        config,
        tokens.access_token,
        connectionKey(account.id, "access"),
      ),
      refreshToken: sealOutlookSecret(
        config,
        tokens.refresh_token!,
        connectionKey(account.id, "refresh"),
      ),
      accessTokenExpiresAt: new Date(
        Date.now() + tokens.expires_in * 1000,
      ).toISOString(),
      calendarId: sameAccount ? current?.calendarId : null,
      calendarName: sameAccount ? current?.calendarName : null,
      status: "connected",
      updatedAt: nowIso(),
    };
    await tx
      .insert(outlookCalendarConnectionTable)
      .values({ id: connectionId, ...fields })
      .onConflictDoUpdate({
        target: outlookCalendarConnectionTable.id,
        set: fields,
      });
  });
}

async function connectionOperation<T>(
  action: (graph: Graph, tx: Transaction) => Promise<T>,
) {
  const config = requireConfig();
  const outcome = await serialOutlook(async (tx) => {
    const connection = await getConnection(tx);
    if (!connection || connection.status !== "connected")
      throw new DomainError(409, "Connect Outlook in Settings first.");
    try {
      return {
        result: await withGraph(tx, config, connection, (graph) =>
          action(graph, tx),
        ),
      } as const;
    } catch (error) {
      if (error instanceof OutlookError && error.status === 401)
        await markReconnect(tx);
      return { error } as const;
    }
  });
  if ("result" in outcome) return outcome.result as T;
  if (outcome.error instanceof DomainError) throw outcome.error;
  throw new DomainError(
    outcome.error instanceof OutlookError ? outcome.error.status : 502,
    errorMessage(outcome.error),
  );
}

export const listOutlookCalendars = () =>
  connectionOperation((graph) => graph.calendars());

export function selectOutlookCalendar(calendarId: string) {
  return connectionOperation(async (graph, tx) => {
    const calendar = await graph.calendar(calendarId);
    if (!calendar.canEdit)
      throw new DomainError(
        403,
        "Choose a calendar your Microsoft account can edit.",
      );
    await tx
      .update(outlookCalendarConnectionTable)
      .set({
        calendarId: calendar.id,
        calendarName: calendar.name,
        updatedAt: nowIso(),
      })
      .where(eq(outlookCalendarConnectionTable.id, connectionId));
    return { id: calendar.id, name: calendar.name };
  });
}

export async function disconnectOutlookCalendar() {
  await serialOutlook(async (tx) => {
    await tx
      .update(outlookCalendarConnectionTable)
      .set({
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        grantedScopes: "",
        status: "disconnected",
        updatedAt: nowIso(),
      })
      .where(eq(outlookCalendarConnectionTable.id, connectionId));
  });
}

export async function outlookCalendarStatus() {
  const configured = Boolean(getOutlookConfig());
  const connection = await getConnection();
  const pending = connection
    ? await db
        .select({
          bookingId: outlookBookingSyncTable.bookingId,
          jobNumber: jobsTable.jobNumber,
          error: outlookBookingSyncTable.lastError,
          retryAt: outlookBookingSyncTable.retryAt,
        })
        .from(outlookBookingSyncTable)
        .innerJoin(
          crewBookingsTable,
          eq(crewBookingsTable.id, outlookBookingSyncTable.bookingId),
        )
        .innerJoin(jobsTable, eq(jobsTable.id, crewBookingsTable.jobId))
        .where(
          and(
            eq(outlookBookingSyncTable.accountId, connection.accountId),
            gt(
              crewBookingsTable.revision,
              outlookBookingSyncTable.syncedRevision,
            ),
          ),
        )
        .orderBy(asc(crewBookingsTable.startAt))
        .limit(50)
    : [];
  return {
    configured,
    status: configured
      ? (connection?.status ?? "disconnected")
      : "not_configured",
    accountName: connection?.accountName ?? null,
    mailConnected: mailConnected(configured, connection),
    mailboxEmail: connection?.mailboxEmail ?? null,
    calendar: connection?.calendarId
      ? { id: connection.calendarId, name: connection.calendarName }
      : null,
    pending,
  };
}

function mailConnected(
  configured: boolean,
  connection: Connection | undefined,
) {
  return Boolean(
    configured &&
    connection?.status === "connected" &&
    connection.accessToken &&
    connection.refreshToken &&
    connection.mailboxEmail &&
    hasOutlookMailScope(connection.grantedScopes),
  );
}

/** Minimal capability for staff compose dialogs; no calendar or token metadata. */
export async function outlookEmailCapability() {
  const connection = await getConnection();
  const connected = mailConnected(Boolean(getOutlookConfig()), connection);
  return {
    connected,
    mailboxEmail: connected ? connection!.mailboxEmail : null,
  };
}

export async function sendOutlookEmail(message: {
  to: string;
  subject: string;
  body: string;
}): Promise<{ accepted: true; mailboxEmail: string | null }> {
  const config = requireConfig();
  let accepted = false;
  try {
    const outcome = await serialOutlook(async (tx) => {
      const connection = await getConnection(tx);
      if (!mailConnected(true, connection))
        throw new OutlookError(
          "Enable Outlook email in Settings before sending from Microsoft.",
          409,
        );
      try {
        const result = await withGraph(
          tx,
          config,
          connection!,
          async (graph, grantedScopes) => {
            if (!hasOutlookMailScope(grantedScopes))
              throw new OutlookError(
                "Microsoft email permission is no longer available. Enable Outlook email in Settings.",
                403,
              );
            await graph.sendMail(message);
            accepted = true;
            return {
              accepted: true as const,
              mailboxEmail: connection!.mailboxEmail,
            };
          },
        );
        return { result } as const;
      } catch (error) {
        if (error instanceof OutlookError && error.status === 401)
          await markReconnect(tx);
        // Commit token refresh/reconnect status even when submission is refused.
        return { error } as const;
      }
    });
    if (outcome.result) return outcome.result;
    throw outcome.error;
  } catch (error) {
    if (accepted)
      throw new OutlookError(
        "Microsoft accepted the email but Catalyst could not finish recording it. Check Outlook Sent Items before sending again.",
        502,
        60,
        true,
      );
    throw error;
  }
}

export async function trackOutlookBooking(
  tx: Transaction,
  bookingId: string,
  status: string,
) {
  if (status !== "Confirmed" || !getOutlookConfig()) return;
  const connection = await getConnection(tx);
  if (!connection?.calendarId || connection.status !== "connected") return;
  await tx
    .insert(outlookBookingSyncTable)
    .values({
      bookingId,
      accountId: connection.accountId,
      calendarId: connection.calendarId,
      updatedAt: nowIso(),
    })
    .onConflictDoNothing();
}

export async function queueUpcomingOutlookBookings() {
  requireConfig();
  return serialOutlook(async (tx) => {
    const connection = await getConnection(tx);
    if (!connection?.calendarId || connection.status !== "connected")
      throw new DomainError(
        409,
        "Connect Outlook and choose a writable calendar first.",
      );
    const bookings = await tx
      .select({ bookingId: crewBookingsTable.id })
      .from(crewBookingsTable)
      .where(
        and(
          eq(crewBookingsTable.status, "Confirmed"),
          gt(crewBookingsTable.endAt, nowIso()),
        ),
      );
    if (!bookings.length) return 0;
    const calendarId = connection.calendarId;
    const updatedAt = nowIso();
    const inserted = await tx
      .insert(outlookBookingSyncTable)
      .values(
        bookings.map(({ bookingId }) => ({
          bookingId,
          accountId: connection.accountId,
          calendarId,
          updatedAt,
        })),
      )
      .onConflictDoNothing()
      .returning({ bookingId: outlookBookingSyncTable.bookingId });
    return inserted.length;
  });
}

async function saveOutlookReview(tx: Transaction, bookingId: string, kind: OutlookReviewKind, previous: OutlookEventSnapshot | null, remote: OutlookEventSnapshot | null) {
  const [existing] = await tx.select().from(outlookBookingReviewsTable).where(eq(outlookBookingReviewsTable.bookingId, bookingId));
  if (existing?.status === "pending" && existing.kind === kind && sameOutlookVersion(existing.remoteSnapshot, remote)) return;
  const fields = { kind, status: "pending" as const, previousSnapshot: previous, remoteSnapshot: remote,
    detectedAt: nowIso(), resolvedAt: null, resolvedBy: null, resolution: null, note: null };
  await tx.insert(outlookBookingReviewsTable).values({ bookingId, ...fields }).onConflictDoUpdate({ target: outlookBookingReviewsTable.bookingId,
    set: { ...fields, revision: (existing?.revision ?? 0) + 1 } });
  await audit("outlook.external_change_detected", { entityType: "crew_booking", entityId: bookingId, details: { kind } }, tx);
}

async function syncOneOutlookBooking(bookingId: string) {
  const config = getOutlookConfig();
  if (!config) return;
  await serialOutlook(async (tx) => {
    const connection = await getConnection(tx);
    if (!connection || connection.status !== "connected") return;
    const [row] = await tx.select({ sync: outlookBookingSyncTable, booking: crewBookingsTable, jobNumber: jobsTable.jobNumber, crewName: crewsTable.name })
      .from(outlookBookingSyncTable).innerJoin(crewBookingsTable, eq(crewBookingsTable.id, outlookBookingSyncTable.bookingId))
      .innerJoin(jobsTable, eq(jobsTable.id, crewBookingsTable.jobId)).innerJoin(crewsTable, eq(crewsTable.id, crewBookingsTable.crewId))
      .where(and(eq(outlookBookingSyncTable.bookingId, bookingId), eq(outlookBookingSyncTable.accountId, connection.accountId)));
    if (!row || (row.sync.retryAt && row.sync.retryAt > nowIso())) return;
    try {
      await withGraph(tx, config, connection, async (graph) => {
        const { calendarId, generation } = row.sync;
        const key = "catalyst-" + bookingId + "-" + generation;
        const eventId = row.sync.eventId ?? (row.booking.revision > row.sync.syncedRevision ? await graph.findInstallation(calendarId, key) : null);
        const remote = eventId ? await graph.readInstallation(calendarId, eventId) : null;
        const now = nowIso();
        await tx.update(outlookBookingSyncTable).set({ externalCheckedAt: now, lastError: null, retryAt: null }).where(eq(outlookBookingSyncTable.bookingId, bookingId));
        const [review] = await tx.select().from(outlookBookingReviewsTable).where(eq(outlookBookingReviewsTable.bookingId, bookingId));
        const local = { ...row.booking, jobNumber: row.jobNumber };
        const kind = eventId ? detectOutlookReview(row.sync.externalSnapshot, remote, local) : null;
        if (review?.status === "pending" || kind) {
          await saveOutlookReview(tx, bookingId, kind ?? review!.kind, row.sync.externalSnapshot, remote);
          return;
        }
        if (row.booking.revision <= row.sync.syncedRevision) {
          if (remote && !row.sync.externalSnapshot) await tx.update(outlookBookingSyncTable).set({ externalSnapshot: remote }).where(eq(outlookBookingSyncTable.bookingId, bookingId));
          return;
        }
        const cancelled = row.booking.status === "Cancelled";
        const event = { jobNumber: row.jobNumber, crewName: row.crewName, startAt: row.booking.startAt, endAt: row.booking.endAt };
        let next: OutlookEventSnapshot | null = null;
        if (cancelled) { if (remote) await graph.deleteReviewedInstallation(calendarId, remote.id, remote.etag); }
        else next = remote ? await graph.updateReviewedInstallation(calendarId, remote.id, event, remote.etag, true)
          : await graph.createReviewedInstallation(calendarId, key, event);
        await tx.update(outlookBookingSyncTable).set({ eventId: next?.id ?? null, externalSnapshot: next,
          generation: generation + (cancelled ? 1 : 0), syncedRevision: row.booking.revision, lastSyncedAt: now,
          externalCheckedAt: now, updatedAt: now, retryAt: null, lastError: null }).where(eq(outlookBookingSyncTable.bookingId, bookingId));
      });
    } catch (error) {
      if (error instanceof OutlookError && [404, 412].includes(error.status) && row.sync.eventId) {
        try {
          const remote = await withGraph(tx, config, connection, (graph) => graph.readInstallation(row.sync.calendarId, row.sync.eventId!));
          await saveOutlookReview(tx, bookingId, remote ? "edited" : "deleted", row.sync.externalSnapshot, remote);
          return;
        } catch (readError) { error = readError; }
      }
      if (error instanceof OutlookError && error.status === 401) await markReconnect(tx);
      const retrySeconds = error instanceof OutlookError ? error.retryAfterSeconds : 60;
      await tx.update(outlookBookingSyncTable).set({ lastError: errorMessage(error), updatedAt: nowIso(),
        retryAt: new Date(Date.now() + Math.max(30, retrySeconds) * 1000).toISOString() }).where(eq(outlookBookingSyncTable.bookingId, bookingId));
    }
  });
}

export async function listOutlookBookingReviews() {
  const connection = await getConnection();
  if (!connection) return { reviews: [] };
  const rows = await db.select({ review: outlookBookingReviewsTable, booking: crewBookingsTable, jobNumber: jobsTable.jobNumber, crewName: crewsTable.name })
    .from(outlookBookingReviewsTable).innerJoin(crewBookingsTable, eq(crewBookingsTable.id, outlookBookingReviewsTable.bookingId))
    .innerJoin(outlookBookingSyncTable, eq(outlookBookingSyncTable.bookingId, crewBookingsTable.id))
    .innerJoin(jobsTable, eq(jobsTable.id, crewBookingsTable.jobId)).innerJoin(crewsTable, eq(crewsTable.id, crewBookingsTable.crewId))
    .where(and(eq(outlookBookingReviewsTable.status, "pending"), eq(outlookBookingSyncTable.accountId, connection.accountId)))
    .orderBy(asc(outlookBookingReviewsTable.detectedAt)).limit(100);
  return { reviews: rows.map(({ review, booking, jobNumber, crewName }) => ({ bookingId: booking.id, jobNumber, crewName,
    bookingRevision: booking.revision, reviewRevision: review.revision, kind: review.kind, detectedAt: review.detectedAt,
    local: { startAt: booking.startAt, endAt: booking.endAt, status: booking.status, plannedLaborHours: booking.plannedLaborHours },
    previous: review.previousSnapshot, remote: review.remoteSnapshot })) };
}

export async function resolveOutlookBookingReview(bookingId: string, input: {
  bookingRevision: number; reviewRevision: number; action: "use_outlook" | "reapply_local"; note: string;
}, actorUserId: string) {
  return connectionOperation(async (graph, tx) => {
    const connection = await getConnection(tx);
    const [sync] = await tx.select().from(outlookBookingSyncTable).where(and(eq(outlookBookingSyncTable.bookingId, bookingId), eq(outlookBookingSyncTable.accountId, connection!.accountId)));
    const [review] = await tx.select().from(outlookBookingReviewsTable).where(eq(outlookBookingReviewsTable.bookingId, bookingId));
    if (!sync || !review) throw new DomainError(404, "Outlook review not found.");
    assertRevision(review.revision, input.reviewRevision);
    if (review.status === "resolved") {
      if (review.resolution === input.action && review.note === input.note && review.resolvedBy === actorUserId) return { resolved: true };
      throw new DomainError(409, "This Outlook review was already resolved. Refresh the list.");
    }
    const [before] = await tx.select().from(crewBookingsTable).where(eq(crewBookingsTable.id, bookingId));
    if (!before) throw new DomainError(404, "Booking not found.");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"crew:" + before.crewId}))`);
    const [booking] = await tx.select().from(crewBookingsTable).where(eq(crewBookingsTable.id, bookingId)).for("update");
    if (!booking || booking.crewId !== before.crewId) throw new DomainError(409, "The assigned crew changed. Refresh before reviewing.");
    assertRevision(booking.revision, input.bookingRevision);
    const remote = sync.eventId ? await graph.readInstallation(sync.calendarId, sync.eventId) : null;
    if (!sameOutlookVersion(review.remoteSnapshot, remote)) {
      await saveOutlookReview(tx, bookingId, remote ? "edited" : "deleted", sync.externalSnapshot, remote);
      throw new DomainError(409, "Outlook changed again. Review the latest event before choosing an action.");
    }
    const now = nowIso();
    let next = remote, nextRevision = booking.revision, generation = sync.generation;
    if (input.action === "use_outlook") {
      const changes = acceptedOutlookSchedule(remote);
      const accepted = { ...booking, ...changes };
      await assertCrewBookingAvailability(tx, accepted, booking.id);
      nextRevision++;
      await tx.update(crewBookingsTable).set({ ...changes, revision: nextRevision, updatedAt: now, calendarSyncStatus: "pending", calendarSyncError: null }).where(eq(crewBookingsTable.id, bookingId));
      if (booking.taskId) await tx.update(tasksTable).set({ startAt: accepted.startAt, endAt: accepted.endAt,
        status: accepted.status === "Cancelled" ? "Cancelled" : "Open", updatedAt: now }).where(eq(tasksTable.id, booking.taskId));
      if (accepted.status === "Cancelled") { next = null; generation++; }
    } else {
      const [job] = await tx.select().from(jobsTable).where(eq(jobsTable.id, booking.jobId));
      const [crew] = await tx.select().from(crewsTable).where(eq(crewsTable.id, booking.crewId));
      if (!job || !crew) throw new DomainError(404, "Crew or job not found.");
      const event = { jobNumber: job.jobNumber, crewName: crew.name, startAt: booking.startAt, endAt: booking.endAt };
      try {
        if (booking.status === "Cancelled") {
          if (remote) await graph.deleteReviewedInstallation(sync.calendarId, remote.id, remote.etag);
          next = null; generation++;
        } else if (remote && !remote.isCancelled) {
          if (remote.isAllDay || remote.type !== "singleInstance") throw new DomainError(400, "Restore this Outlook event to a single timed installation before reapplying the app schedule.");
          next = await graph.updateReviewedInstallation(sync.calendarId, remote.id, event, remote.etag, true);
        }
        else {
          generation++;
          const key = `catalyst-${bookingId}-${generation}`;
          const existing = await graph.findInstallation(sync.calendarId, key);
          next = existing ? await graph.readInstallation(sync.calendarId, existing) : await graph.createReviewedInstallation(sync.calendarId, key, event);
          if (!next) throw new DomainError(409, "The replacement Outlook event could not be verified. Check the calendar before retrying.");
          if (existing && !matchesLocalOutlookSchedule(next, event)) {
            await tx.update(outlookBookingSyncTable).set({ eventId: existing, generation }).where(eq(outlookBookingSyncTable.bookingId, bookingId));
            await saveOutlookReview(tx, bookingId, "unverified", null, next);
            throw new DomainError(409, "The replacement Outlook event changed. Review it before applying the app schedule.");
          }
        }
      } catch (error) {
        if (error instanceof OutlookError && [404, 412].includes(error.status) && sync.eventId) {
          const latest = await graph.readInstallation(sync.calendarId, sync.eventId);
          await saveOutlookReview(tx, bookingId, latest ? "edited" : "deleted", sync.externalSnapshot, latest);
          throw new DomainError(409, "Outlook changed while saving. Review its latest version.");
        }
        throw error;
      }
    }
    await tx.update(outlookBookingSyncTable).set({ eventId: next?.id ?? null, externalSnapshot: next, externalCheckedAt: now,
      syncedRevision: nextRevision, generation, lastSyncedAt: now, lastError: null, retryAt: null, updatedAt: now }).where(eq(outlookBookingSyncTable.bookingId, bookingId));
    await tx.update(outlookBookingReviewsTable).set({ status: "resolved", resolvedAt: now, resolvedBy: actorUserId, resolution: input.action, note: input.note }).where(eq(outlookBookingReviewsTable.bookingId, bookingId));
    await audit("outlook.external_change_resolved", { userId: actorUserId, entityType: "crew_booking", entityId: bookingId,
      details: { action: input.action, note: input.note, reviewRevision: review.revision, bookingRevision: nextRevision } }, tx);
    return { resolved: true };
  });
}

const running = new Set<string>();
export async function processOutlookBookingQueue() {
  const key = workspaceScopeKey();
  if (running.has(key) || !getOutlookConfig()) return;
  running.add(key);
  try {
    const connection = await getConnection();
    if (connection?.status !== "connected") return;
    const queued = await db
      .select({ id: outlookBookingSyncTable.bookingId })
      .from(outlookBookingSyncTable)
      .innerJoin(
        crewBookingsTable,
        eq(crewBookingsTable.id, outlookBookingSyncTable.bookingId),
      )
      .leftJoin(outlookBookingReviewsTable, eq(outlookBookingReviewsTable.bookingId, outlookBookingSyncTable.bookingId))
      .where(
        and(
          eq(outlookBookingSyncTable.accountId, connection.accountId),
          or(
            and(gt(crewBookingsTable.revision, outlookBookingSyncTable.syncedRevision), or(isNull(outlookBookingReviewsTable.bookingId), eq(outlookBookingReviewsTable.status, "resolved"))),
            and(isNotNull(outlookBookingSyncTable.eventId), or(isNull(outlookBookingSyncTable.externalCheckedAt), lte(outlookBookingSyncTable.externalCheckedAt, new Date(Date.now() - 120_000).toISOString()))),
          ),
          or(
            isNull(outlookBookingSyncTable.retryAt),
            lte(outlookBookingSyncTable.retryAt, nowIso()),
          ),
        ),
      )
      .orderBy(sql`(${crewBookingsTable.revision} > ${outlookBookingSyncTable.syncedRevision}) DESC`, sql`${outlookBookingSyncTable.externalCheckedAt} ASC NULLS FIRST`)
      .limit(8);
    for (const booking of queued) await syncOneOutlookBooking(booking.id);
  } finally {
    running.delete(key);
  }
}

export function requestOutlookBookingSync() {
  void withWorkspaceConnection(() => processOutlookBookingQueue()).catch(() =>
    logger.error("Outlook booking queue could not run"),
  );
}

const syncTimers = new Map<string, NodeJS.Timeout>();
export function stopOutlookBookingWorker() {
  const key = workspaceScopeKey();
  const timer = syncTimers.get(key);
  if (timer) clearInterval(timer);
  syncTimers.delete(key);
}
export function startOutlookBookingWorker() {
  const key = workspaceScopeKey();
  if (syncTimers.has(key) || !getOutlookConfig()) return;
  requestOutlookBookingSync();
  const syncTimer = setInterval(requestOutlookBookingSync, 30_000);
  syncTimers.set(key, syncTimer);
  syncTimer.unref();
}
