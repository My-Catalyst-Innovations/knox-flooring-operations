import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, usersTable } from "@workspace/db";
import { audit } from "../lib/auth";
import { domainRoute, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { requireAuth } from "../middlewares/auth";

const router = Router();
const publicFields = {
  id: usersTable.id, email: usersTable.email, name: usersTable.name,
  phone: usersTable.phone, jobTitle: usersTable.jobTitle, role: usersTable.role,
};
const text = (maximum: number, minimum = 0) => z.string().trim().min(minimum, "Enter your full name.").max(maximum).refine(value => !/[\p{Cc}]/u.test(value), "Use a single line of text.");
export const profileInput = z.object({
  name: text(150, 1),
  phone: text(50).refine(value => /^[+()\d .-]*$/.test(value), "Enter a valid phone number."),
  jobTitle: text(100),
}).strict();

router.get("/auth/profile", requireAuth, domainRoute(async (req, res) => {
  const [profile] = await db.select(publicFields).from(usersTable).where(and(
    eq(usersTable.id, req.auth!.userId), eq(usersTable.active, true),
  ));
  if (!profile) throw new DomainError(401, "Sign in again to view your profile.");
  res.setHeader("Cache-Control", "no-store");
  res.json(profile);
}));

router.patch("/auth/profile", requireAuth, domainRoute(async (req, res) => {
  if (req.auth!.previewRole) throw new DomainError(403, "Exit role preview to edit your profile.");
  const data = parse(profileInput, req.body);
  const profile = await db.transaction(async tx => {
    const [saved] = await tx.update(usersTable).set({ ...data, updatedAt: new Date().toISOString() }).where(and(
      eq(usersTable.id, req.auth!.userId), eq(usersTable.active, true),
    )).returning(publicFields);
    if (!saved) throw new DomainError(401, "Sign in again to edit your profile.");
    await audit("auth.profile_updated", { userId: req.auth!.userId, entityType: "user", entityId: req.auth!.userId,
      ip: req.ip, details: { fields: ["name", "phone", "jobTitle"] } }, tx);
    return saved;
  });
  res.setHeader("Cache-Control", "no-store");
  res.json(profile);
}));

export default router;
