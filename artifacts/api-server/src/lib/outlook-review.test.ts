import { describe, expect, it } from "vitest";
import { acceptedOutlookSchedule, detectOutlookReview, graphUtc, outlookEventSnapshotSchema, sameOutlookVersion } from "./outlook-review";

const local = { jobNumber: "K-10", startAt: "2026-11-01T01:30:00-04:00", endAt: "2026-11-01T01:30:00-05:00" };
const remote = outlookEventSnapshotSchema.parse({ id: "event", "@odata.etag": 'W/"one"', changeKey: "one", subject: "Installation K-10",
  start: { dateTime: "2026-11-01T05:30:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-01T06:30:00", timeZone: "UTC" }, isCancelled: false, isAllDay: false, type: "singleInstance" });
describe("Outlook external-change review", () => {
  it("compares UTC instants through the repeated DST hour without server-local parsing", () => {
    expect(graphUtc("2026-11-01T05:30:00.0000000")).toBe("2026-11-01T05:30:00.000Z");
    expect(detectOutlookReview(null, remote, local)).toBeNull();
    expect(acceptedOutlookSchedule(remote)).toMatchObject({ startAt: "2026-11-01T05:30:00.000Z", endAt: "2026-11-01T06:30:00.000Z" });
  });
  it("requires review for legacy mismatches, external version changes and deleted events", () => {
    expect(detectOutlookReview(null, { ...remote, subject: "Customer changed title" }, local)).toBe("unverified");
    expect(detectOutlookReview(remote, { ...remote, etag: 'W/"two"' }, local)).toBe("edited");
    expect(detectOutlookReview(remote, null, local)).toBe("deleted");
    expect(detectOutlookReview(remote, remote, local)).toBeNull();
    expect(sameOutlookVersion(null, remote)).toBe(false);
  });
  it("accepts deletion only as an explicit booking cancellation and refuses unsupported recurring/all-day times", () => {
    expect(acceptedOutlookSchedule(null)).toEqual({ status: "Cancelled" });
    expect(acceptedOutlookSchedule({ ...remote, isCancelled: true })).toEqual({ status: "Cancelled" });
    expect(() => acceptedOutlookSchedule({ ...remote, isAllDay: true })).toThrow(/all-day/);
    expect(() => acceptedOutlookSchedule({ ...remote, type: "seriesMaster" })).toThrow(/recurring/);
    expect(() => acceptedOutlookSchedule({ ...remote, endAt: remote.startAt })).toThrow(/end time/);
    expect(() => graphUtc("not-a-time")).toThrow();
  });
});
