import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { DomainError } from "./operations-rules";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Revalidate the actual tenant owner after record/advisory waits and retain
 * a share lock through the write, so role/deactivation changes cannot race it. */
export async function assertActiveCutoverOwner(tx: Tx, actor: string) {
  const [owner] = await tx
    .select({
      role: usersTable.role,
      active: usersTable.active,
      lockedUntil: usersTable.lockedUntil,
    })
    .from(usersTable)
    .where(eq(usersTable.id, actor))
    .for("share");
  if (
    !owner?.active ||
    owner.role !== "owner" ||
    (owner.lockedUntil && Date.parse(owner.lockedUntil) > Date.now())
  )
    throw new DomainError(
      403,
      "An active owner must review and accept this migration in the current company.",
    );
}
