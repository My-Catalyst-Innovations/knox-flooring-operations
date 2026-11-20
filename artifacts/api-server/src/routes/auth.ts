import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, passwordResetTokensTable, sessionsTable, usersTable } from "@workspace/db";
import { audit, createSession, hashPassword, hashToken, newToken, normalizeEmail, SESSION_COOKIE, SESSION_TTL_MS, verifyPassword } from "../lib/auth";
import { requireAuth } from "../middlewares/auth";
import staffRouter from "./staff";

const router: IRouter = Router();
router.use(staffRouter);
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: SESSION_TTL_MS };
const attempts = new Map<string, { count: number; resetAt: number }>();

export function isDemoAccessEnabled() {
  return process.env.DEMO_ACCESS_ENABLED === "true";
}

router.post("/auth/demo", async (req, res) => {
  if (!isDemoAccessEnabled()) {
    res.status(404).json({ error: "Demo access is not enabled" });
    return;
  }

  const [owner] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.role, "owner"), eq(usersTable.active, true)))
    .limit(1);

  if (!owner) {
    res.status(503).json({ error: "The demo owner account is not available" });
    return;
  }

  const session = await createSession(owner.id, req.ip, req.get("user-agent") ?? "");
  res.cookie(SESSION_COOKIE, session.token, cookieOptions);
  await audit("auth.demo_access", {
    userId: owner.id,
    entityType: "user",
    entityId: owner.id,
    ip: req.ip,
    details: { temporaryBypass: true },
  });
  res.json({
    user: { id: owner.id, email: owner.email, name: owner.name, role: owner.role, actualRole: owner.role, previewRole: null },
    csrfToken: session.csrfToken,
  });
});

router.post("/auth/login", async (req, res) => {
  const email = normalizeEmail(String(req.body?.email ?? ""));
  const password = String(req.body?.password ?? "");
  const key = `${req.ip}:${email}`;
  const rate = attempts.get(key);
  if (rate && rate.resetAt > Date.now() && rate.count >= 8) { res.status(429).json({ error: "Too many attempts. Try again later." }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  const locked = user?.lockedUntil && user.lockedUntil > new Date().toISOString();
  if (!user || !user.active || locked || !(await verifyPassword(user.passwordHash, password))) {
    const count = (rate?.resetAt ?? 0) > Date.now() ? rate!.count + 1 : 1;
    attempts.set(key, { count, resetAt: Date.now() + 15 * 60_000 });
    if (user) await db.update(usersTable).set({ failedLoginCount: user.failedLoginCount + 1, lockedUntil: user.failedLoginCount >= 7 ? new Date(Date.now() + 15 * 60_000).toISOString() : null }).where(and(eq(usersTable.id, user.id), eq(usersTable.passwordHash, user.passwordHash)));
    await audit("auth.login_failed", { entityType: "user", entityId: user?.id, ip: req.ip, details: { email } });
    res.status(401).json({ error: "Invalid email or password" }); return;
  }
  const signedIn = await db.transaction(async (tx) => {
    const [current] = await tx.select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, lockedUntil: usersTable.lockedUntil })
      .from(usersTable).where(and(eq(usersTable.id, user.id), eq(usersTable.active, true), eq(usersTable.passwordHash, user.passwordHash))).for("update");
    const now = new Date().toISOString();
    if (!current || (current.lockedUntil && current.lockedUntil > now)) return null;
    const session = await createSession(current.id, req.ip, req.get("user-agent") ?? "", tx);
    await tx.update(usersTable).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, updatedAt: now }).where(eq(usersTable.id, current.id));
    await audit("auth.login", { userId: current.id, entityType: "user", entityId: current.id, ip: req.ip }, tx);
    return { current, session };
  });
  if (!signedIn) { res.status(401).json({ error: "Invalid email or password" }); return; }
  attempts.delete(key);
  const { current, session } = signedIn;
  res.cookie(SESSION_COOKIE, session.token, cookieOptions);
  res.json({ user: { id: current.id, email: current.email, name: current.name, role: current.role, actualRole: current.role, previewRole: null }, csrfToken: session.csrfToken });
});

router.get("/auth/session", requireAuth, (req, res) => res.json({ user: req.auth, csrfToken: req.auth!.csrfToken }));

router.post("/auth/persona", requireAuth, async (req, res) => {
  if (req.auth!.actualRole !== "owner") { res.status(403).json({ error: "Only the owner can preview another role" }); return; }
  const requested = req.body?.role === null ? null : String(req.body?.role ?? "");
  const allowed = ["sales", "operations", "installer"];
  if (requested !== null && !allowed.includes(requested)) { res.status(400).json({ error: "Invalid preview role" }); return; }
  const token = req.cookies?.[SESSION_COOKIE];
  await db.update(sessionsTable).set({ previewRole: requested }).where(eq(sessionsTable.tokenHash, hashToken(token)));
  await audit(requested ? "auth.persona_preview_started" : "auth.persona_preview_ended", { userId: req.auth!.userId, entityType: "session", ip: req.ip, details: { role: requested } });
  res.json({ user: { id: req.auth!.userId, email: req.auth!.email, name: req.auth!.name, role: requested ?? "owner", actualRole: "owner", previewRole: requested }, csrfToken: req.auth!.csrfToken });
});

router.post("/auth/logout", requireAuth, async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db.delete(sessionsTable).where(eq(sessionsTable.tokenHash, hashToken(token)));
  res.clearCookie(SESSION_COOKIE, cookieOptions); await audit("auth.logout", { userId: req.auth!.userId, ip: req.ip }); res.status(204).end();
});

router.post("/auth/password/forgot", async (req, res) => {
  const email = normalizeEmail(String(req.body?.email ?? ""));
  const reset = await db.transaction(async (tx) => {
    const [user] = await tx.select({ id: usersTable.id }).from(usersTable)
      .where(and(eq(usersTable.email, email), eq(usersTable.active, true))).for("update");
    if (!user) return null;
    const token = newToken(); const now = new Date();
    await tx.insert(passwordResetTokensTable).values({ id: randomUUID(), userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), createdAt: now.toISOString() });
    return { userId: user.id, token };
  });
  if (reset) {
    if (process.env.RESEND_API_KEY && process.env.APP_BASE_URL) {
      await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL ?? "Knox Ops <noreply@knoxflooring.com>", to: [email], subject: "Reset your Knox Ops password", html: `<p>A password reset was requested for Knox Ops.</p><p><a href="${process.env.APP_BASE_URL}/welcome?reset=${encodeURIComponent(reset.token)}">Reset password</a></p><p>This link expires in 30 minutes.</p>` }) });
    }
    await audit("auth.password_reset_requested", { entityType: "user", entityId: reset.userId, ip: req.ip });
  }
  res.status(202).json({ message: "If that account exists, a reset email has been sent." });
});

router.post("/auth/password/reset", async (req, res) => {
  const token = String(req.body?.token ?? ""); const password = String(req.body?.password ?? "");
  if (password.length < 12) { res.status(400).json({ error: "Password must be at least 12 characters" }); return; }
  const tokenHash = hashToken(token);
  const validReset = (now: string) => and(eq(passwordResetTokensTable.tokenHash, tokenHash), gt(passwordResetTokensTable.expiresAt, now), isNull(passwordResetTokensTable.usedAt));
  const [reset] = await db.select().from(passwordResetTokensTable).where(validReset(new Date().toISOString())).limit(1);
  if (!reset) { res.status(400).json({ error: "Reset link is invalid or expired" }); return; }
  const passwordHash = await hashPassword(password);
  const changed = await db.transaction(async (tx) => {
    const [active] = await tx.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, reset.userId), eq(usersTable.active, true))).for("update");
    if (!active) return false;
    const now = new Date().toISOString();
    const [claimed] = await tx.update(passwordResetTokensTable).set({ usedAt: now })
      .where(and(eq(passwordResetTokensTable.id, reset.id), validReset(now))).returning({ id: passwordResetTokensTable.id });
    if (!claimed) return false;
    await tx.update(usersTable).set({ passwordHash, updatedAt: now }).where(eq(usersTable.id, reset.userId));
    await tx.delete(sessionsTable).where(eq(sessionsTable.userId, reset.userId));
    await audit("auth.password_reset", { entityType: "user", entityId: reset.userId, ip: req.ip }, tx);
    return true;
  });
  if (!changed) { res.status(400).json({ error: "Reset link is invalid or expired" }); return; }
  res.status(204).end();
});

router.post("/auth/password/change", requireAuth, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword ?? "");
  const newPassword = String(req.body?.newPassword ?? "");
  if (newPassword.length < 12) { res.status(400).json({ error: "New password must be at least 12 characters" }); return; }
  if (currentPassword === newPassword) { res.status(400).json({ error: "Choose a new password that is different from the current password" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.auth!.userId)).limit(1);
  if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) { res.status(400).json({ error: "Current password is incorrect" }); return; }
  await db.update(usersTable).set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date().toISOString() }).where(eq(usersTable.id, user.id));
  await audit("auth.password_changed", { userId: user.id, entityType: "user", entityId: user.id, ip: req.ip });
  res.status(204).end();
});

export async function bootstrapOwner() {
  const email = process.env.OWNER_EMAIL ? normalizeEmail(process.env.OWNER_EMAIL) : "";
  const password = process.env.OWNER_INITIAL_PASSWORD ?? "";
  if (!email || password.length < 12) return;
  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  if (existing) return;
  const now = new Date().toISOString();
  await db.insert(usersTable).values({ id: randomUUID(), email, passwordHash: await hashPassword(password), name: process.env.OWNER_NAME ?? "Owner", role: "owner", createdAt: now, updatedAt: now });
  await audit("auth.owner_bootstrapped", { entityType: "user", details: { email } });
}

export default router;
