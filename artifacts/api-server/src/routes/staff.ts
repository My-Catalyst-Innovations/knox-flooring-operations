import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db, passwordResetTokensTable, sessionsTable, usersTable } from "@workspace/db";
import { audit, hashPassword, hashToken, newToken, normalizeEmail } from "../lib/auth";
import { domainRoute, id, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { requireAuth, requireOwner } from "../middlewares/auth";

const router = Router();
const path = "/auth/staff";
const inviteLifetime = 48 * 60 * 60 * 1000;
const pendingPassword = "!staff-invitation-pending";
const blockedPassword = "!staff-access-disabled";
const passwords = passwordResetTokensTable;
const inviteHash = (token: string) => `staff:${hashToken(token)}`;
const managedStaffLock = sql`select pg_advisory_xact_lock(hashtext('catalyst:staff-management'))`;
const rosterFields = {
  id: usersTable.id,
  name: usersTable.name,
  email: usersTable.email,
  role: usersTable.role,
  active: usersTable.active,
  invitationPending: sql<boolean>`${usersTable.passwordHash} = ${pendingPassword}`,
};
const invitationInput = z.object({
  name: z.string().trim().min(1).max(150),
  email: z.string().trim().max(254).email().transform(normalizeEmail),
  role: z.enum(["owner", "sales", "operations", "installer"]),
});
const acceptInput = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().min(12, "Use a password of at least 12 characters.").max(256),
});

type StaffTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockOwner(tx: StaffTransaction, actorId: string) {
  await tx.execute(managedStaffLock);
  const [owner] = await tx.select({ id: usersTable.id }).from(usersTable).where(and(
    eq(usersTable.id, actorId),
    eq(usersTable.active, true),
    eq(usersTable.role, "owner"),
  ));
  if (!owner) throw new DomainError(403, "An active owner must manage staff access.");
}

async function invalidateAccess(tx: StaffTransaction, userId: string, now: string) {
  await tx.delete(sessionsTable).where(eq(sessionsTable.userId, userId));
  await tx.update(passwords).set({ usedAt: now }).where(and(eq(passwords.userId, userId), isNull(passwords.usedAt)));
}

async function saveInvitation(tx: StaffTransaction, userId: string, now: Date) {
  const token = newToken();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + inviteLifetime).toISOString();
  await tx.insert(passwords).values({
    id: randomUUID(), userId, tokenHash: inviteHash(token), createdAt, expiresAt,
  });
  return { token, expiresAt };
}

const liveInvitation = (hash: string, now: string) => and(
  eq(passwords.tokenHash, hash),
  gt(passwords.expiresAt, now),
  isNull(passwords.usedAt),
);

router.use(path, (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  // A public evaluation owner session must never mint or accept durable login credentials.
  if (process.env.DEMO_ACCESS_ENABLED === "true") {
    res.status(403).json({ error: "Staff access is unavailable while public demo sign-in is enabled." });
    return;
  }
  next();
});

router.post(`${path}/accept`, domainRoute(async (req, res) => {
  const { token, password } = parse(acceptInput, req.body);
  const hash = inviteHash(token);
  const [candidate] = await db.select({ userId: passwords.userId }).from(passwords)
    .innerJoin(usersTable, eq(usersTable.id, passwords.userId))
    .where(and(liveInvitation(hash, new Date().toISOString()), eq(usersTable.active, false), eq(usersTable.passwordHash, pendingPassword)));
  if (!candidate) throw new DomainError(400, "This invitation is invalid, expired, or already used.");

  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    // Match the user-first lock order used by invite renewal and account deactivation.
    const [pending] = await tx.select({ id: usersTable.id }).from(usersTable).where(and(
      eq(usersTable.id, candidate.userId), eq(usersTable.active, false), eq(usersTable.passwordHash, pendingPassword),
    )).for("update");
    const now = new Date().toISOString();
    if (!pending) throw new DomainError(400, "This invitation is invalid, expired, or already used.");
    const [invitation] = await tx.update(passwords).set({ usedAt: now })
      .where(and(liveInvitation(hash, now), eq(passwords.userId, pending.id))).returning({ id: passwords.id });
    if (!invitation) throw new DomainError(400, "This invitation is invalid, expired, or already used.");
    await invalidateAccess(tx, pending.id, now);
    await tx.update(usersTable).set({ active: true, passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: now })
      .where(eq(usersTable.id, pending.id));
    await audit("staff.invitation_accepted", { userId: pending.id, entityType: "user", entityId: pending.id, ip: req.ip }, tx);
  });
  res.status(204).end();
}));

router.use(path, requireAuth, requireOwner);

router.get(path, domainRoute(async (_req, res) => {
  res.json(await db.select(rosterFields).from(usersTable).orderBy(asc(usersTable.name), asc(usersTable.email)));
}));

router.post(`${path}/invitations`, domainRoute(async (req, res) => {
  const input = parse(invitationInput, req.body);
  const actorId = req.auth!.userId;
  const invitation = await db.transaction(async (tx) => {
    await lockOwner(tx, actorId);
    const now = new Date();
    const [staff] = await tx.insert(usersTable).values({
      ...input, id: randomUUID(), passwordHash: pendingPassword, active: false,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    }).onConflictDoNothing({ target: usersTable.email }).returning(rosterFields);
    if (!staff) throw new DomainError(409, "An account already uses this email. Find it in Staff access.");
    const link = await saveInvitation(tx, staff.id, now);
    await audit("staff.invited", { userId: actorId, entityType: "user", entityId: staff.id, ip: req.ip, details: { role: staff.role } }, tx);
    return { staff, ...link };
  });
  res.status(201).json(invitation);
}));

router.post(`${path}/:id/invitation`, domainRoute(async (req, res) => {
  const userId = id(req);
  const actorId = req.auth!.userId;
  const invitation = await db.transaction(async (tx) => {
    await lockOwner(tx, actorId);
    const [current] = await tx.select({ active: usersTable.active }).from(usersTable).where(eq(usersTable.id, userId)).for("update");
    if (!current) throw new DomainError(404, "Staff account not found.");
    if (current.active) throw new DomainError(409, "This staff account already has access.");
    const now = new Date();
    await invalidateAccess(tx, userId, now.toISOString());
    const [staff] = await tx.update(usersTable).set({ passwordHash: pendingPassword, updatedAt: now.toISOString() })
      .where(eq(usersTable.id, userId)).returning(rosterFields);
    const link = await saveInvitation(tx, userId, now);
    await audit("staff.invitation_renewed", { userId: actorId, entityType: "user", entityId: userId, ip: req.ip }, tx);
    return { staff, ...link };
  });
  res.status(201).json(invitation);
}));

router.post(`${path}/:id/deactivate`, domainRoute(async (req, res) => {
  const userId = id(req);
  const actorId = req.auth!.userId;
  if (userId === actorId) throw new DomainError(409, "You cannot deactivate your own account.");
  const staff = await db.transaction(async (tx) => {
    await lockOwner(tx, actorId);
    const [current] = await tx.select(rosterFields).from(usersTable).where(eq(usersTable.id, userId)).for("update");
    if (!current) throw new DomainError(404, "Staff account not found.");
    if (!current.active && !current.invitationPending) return current;
    if (current.active && current.role === "owner") {
      const [otherOwner] = await tx.select({ id: usersTable.id }).from(usersTable).where(and(
        ne(usersTable.id, userId), eq(usersTable.role, "owner"), eq(usersTable.active, true),
      ));
      if (!otherOwner) throw new DomainError(409, "Keep at least one active owner.");
    }
    const now = new Date().toISOString();
    await invalidateAccess(tx, userId, now);
    const [updated] = await tx.update(usersTable).set({ active: false, passwordHash: blockedPassword, updatedAt: now })
      .where(eq(usersTable.id, userId)).returning(rosterFields);
    await audit(current.active ? "staff.deactivated" : "staff.invitation_cancelled", {
      userId: actorId, entityType: "user", entityId: userId, ip: req.ip,
    }, tx);
    return updated;
  });
  res.json(staff);
}));

export default router;
