import { z } from "zod";
import { DomainError } from "./operations-rules";

const utcDateTime = z.object({ dateTime: z.string(), timeZone: z.literal("UTC") });
export const outlookEventSnapshotSchema = z.object({
  id: z.string().min(1), "@odata.etag": z.string().min(1), changeKey: z.string().min(1), subject: z.string(),
  start: utcDateTime, end: utcDateTime, isCancelled: z.boolean(), isAllDay: z.boolean(), type: z.string(),
}).transform((event) => ({ id: event.id, etag: event["@odata.etag"], changeKey: event.changeKey, subject: event.subject,
  startAt: graphUtc(event.start.dateTime), endAt: graphUtc(event.end.dateTime), isCancelled: event.isCancelled, isAllDay: event.isAllDay, type: event.type }));

export type OutlookEventSnapshot = z.output<typeof outlookEventSnapshotSchema>;
export type OutlookReviewKind = "edited" | "deleted" | "unverified";

/** Graph is explicitly requested in UTC; never interpret its suffixless value in
 * the server's local zone (including ambiguous/repeated daylight-saving hours). */
export function graphUtc(value: string) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|[+-]\d\d:\d\d)?$/.test(value)) throw new DomainError(502, "Microsoft returned an invalid event time.");
  const parsed = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`);
  if (!Number.isFinite(parsed)) throw new DomainError(502, "Microsoft returned an invalid event time.");
  return new Date(parsed).toISOString();
}

export function sameOutlookVersion(left: OutlookEventSnapshot | null, right: OutlookEventSnapshot | null) {
  return left === null || right === null ? left === right : left.id === right.id && left.etag === right.etag && left.changeKey === right.changeKey;
}

export function matchesLocalOutlookSchedule(remote: OutlookEventSnapshot, local: { jobNumber: string; startAt: string; endAt: string }) {
  return !remote.isCancelled && !remote.isAllDay && remote.type === "singleInstance" && remote.subject === `Installation ${local.jobNumber}` &&
    remote.startAt === new Date(local.startAt).toISOString() && remote.endAt === new Date(local.endAt).toISOString();
}

export function detectOutlookReview(previous: OutlookEventSnapshot | null, remote: OutlookEventSnapshot | null,
  local: { jobNumber: string; startAt: string; endAt: string }): OutlookReviewKind | null {
  if (!remote) return "deleted";
  if (!previous) return matchesLocalOutlookSchedule(remote, local) ? null : "unverified";
  return sameOutlookVersion(previous, remote) ? null : "edited";
}

export function acceptedOutlookSchedule(remote: OutlookEventSnapshot | null) {
  if (!remote || remote.isCancelled) return { status: "Cancelled" } as const;
  if (remote.isAllDay || remote.type !== "singleInstance") throw new DomainError(400, "Review this all-day or recurring event in Outlook and restore it to a single timed installation before accepting it.");
  if (Date.parse(remote.endAt) <= Date.parse(remote.startAt)) throw new DomainError(400, "The Outlook end time must follow its start time.");
  return { status: "Confirmed", startAt: remote.startAt, endAt: remote.endAt } as const;
}
