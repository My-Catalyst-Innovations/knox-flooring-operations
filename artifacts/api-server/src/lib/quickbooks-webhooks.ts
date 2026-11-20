import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const quickBooksId = z.string().regex(/^\d{1,30}$/);
const cloudEventSchema = z.object({
  specversion: z.literal("1.0"),
  id: z.string().min(1),
  source: z.string().min(1),
  type: z.enum([
    "qbo.invoice.created.v1", "qbo.invoice.updated.v1", "qbo.invoice.deleted.v1",
    "qbo.invoice.voided.v1", "qbo.invoice.emailed.v1",
    "qbo.payment.created.v1", "qbo.payment.updated.v1", "qbo.payment.deleted.v1",
    "qbo.payment.voided.v1", "qbo.payment.emailed.v1",
  ]),
  intuitaccountid: quickBooksId,
  intuitentityid: quickBooksId,
}).passthrough();
const legacyNotificationSchema = z.object({
  realmId: quickBooksId,
  dataChangeEvent: z.object({ entities: z.array(z.unknown()) }),
}).passthrough();
const legacyBatchSchema = z.object({ eventNotifications: z.array(z.unknown()) });
const legacyEntitySchema = z.object({
  name: z.enum(["Invoice", "Payment"]),
  id: quickBooksId,
  operation: z.enum(["Create", "Update", "Delete", "Void", "Emailed"]),
});
const storedCloudEventSchema = z.object({ cloudEvent: cloudEventSchema });

type WebhookChange = { entity: "Invoice" | "Payment"; id: string; deleted: boolean };

export function verifyQuickBooksWebhookSignature(rawBody: Buffer, signature: string, verifier: string) {
  const expected = createHmac("sha256", verifier).update(rawBody).digest("base64");
  const actualBytes = Buffer.from(signature);
  return actualBytes.length === expected.length && timingSafeEqual(actualBytes, Buffer.from(expected));
}

function legacyNotifications(payload: unknown, realmId: string) {
  const batch = legacyBatchSchema.safeParse(payload);
  if (!batch.success) return [];
  return batch.data.eventNotifications.flatMap((candidate) => {
    const notification = legacyNotificationSchema.safeParse(candidate);
    return notification.success && notification.data.realmId === realmId ? [notification.data] : [];
  });
}

export function quickBooksWebhookEntries(payload: unknown, rawBody: Buffer, realmId: string) {
  if (Array.isArray(payload)) {
    return payload.flatMap((candidate) => {
      const event = cloudEventSchema.safeParse(candidate);
      if (!event.success || event.data.intuitaccountid !== realmId) return [];
      // One event may be retried in a different batch. CloudEvents identifies it by source and id.
      const eventKey = createHash("sha256")
        .update(JSON.stringify([realmId, event.data.source, event.data.id])).digest("hex");
      return [{ eventKey, realmId, payload: { cloudEvent: event.data } }];
    });
  }
  const notifications = legacyNotifications(payload, realmId);
  if (!notifications.length) return [];
  const eventKey = createHash("sha256").update(rawBody).digest("hex");
  return [{ eventKey, realmId, payload: { eventNotifications: notifications } }];
}

export function quickBooksWebhookChanges(payload: unknown, realmId: string): WebhookChange[] {
  const cloudEvent = storedCloudEventSchema.safeParse(payload);
  if (cloudEvent.success) {
    const event = cloudEvent.data.cloudEvent;
    if (event.intuitaccountid !== realmId) return [];
    return [{
      entity: event.type.startsWith("qbo.invoice.") ? "Invoice" : "Payment",
      id: event.intuitentityid,
      deleted: event.type.endsWith(".deleted.v1"),
    }];
  }
  return legacyNotifications(payload, realmId).flatMap(({ dataChangeEvent }) =>
    dataChangeEvent.entities.flatMap((candidate) => {
      const entity = legacyEntitySchema.safeParse(candidate);
      return entity.success ? [{ entity: entity.data.name, id: entity.data.id, deleted: entity.data.operation === "Delete" }] : [];
    }),
  );
}
