import { createHash, randomUUID } from "node:crypto";
import { db, quickbooksSyncJobsTable } from "@workspace/db";

export function quickBooksReviewRow(entityType: string, localId: string, action: string, payload: Record<string, unknown>, warnings: string[] = [], now = new Date().toISOString()): typeof quickbooksSyncJobsTable.$inferInsert {
  const version = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
  return { id: randomUUID(), idempotencyKey: `${entityType}:${localId}:${action}:${version}`, entityType, localId, action, status: "pending_approval", payload, warnings, nextAttemptAt: now, createdAt: now, updatedAt: now };
}

export async function queueQuickBooksReview(entityType: string, localId: string, action: string, payload: Record<string, unknown>, warnings: string[] = []) {
  await db.insert(quickbooksSyncJobsTable).values(quickBooksReviewRow(entityType, localId, action, payload, warnings)).onConflictDoNothing();
}
