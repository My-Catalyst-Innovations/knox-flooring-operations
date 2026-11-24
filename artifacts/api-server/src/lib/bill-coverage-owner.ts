import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { DomainError } from "./operations-rules";
export type CoverageTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];
export async function assertCoverageOwner(
  tx: CoverageTransaction,
  actor: string,
) {
  const [user] = await tx
    .select({
      role: usersTable.role,
      active: usersTable.active,
      lockedUntil: usersTable.lockedUntil,
    })
    .from(usersTable)
    .where(eq(usersTable.id, actor))
    .for("share");
  if (
    !user?.active ||
    user.role !== "owner" ||
    (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now())
  )
    throw new DomainError(
      403,
      "An active company owner outside role preview must review supplier bill evidence.",
    );
}
