import { eq } from "drizzle-orm";
import { db, crewBookingsTable, crewsTable } from "@workspace/db";
import { assertBooking, DomainError, overlaps } from "./operations-rules";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Booking = typeof crewBookingsTable.$inferSelect;

/** Both ordinary edits and explicit Outlook review use these same crew guards.
 * Caller holds the crew advisory lock before reading competing bookings. */
export async function assertCrewBookingAvailability(tx: Transaction,
  input: Pick<Booking, "crewId" | "startAt" | "endAt" | "plannedLaborHours"> & { status?: string },
  excludedBookingId?: string) {
  const duration = assertBooking(input);
  const [crew] = await tx.select().from(crewsTable).where(eq(crewsTable.id, input.crewId));
  if (!crew) throw new DomainError(404, "Crew not found");
  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: crew.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const startDay = dayFmt.format(new Date(input.startAt));
  const endDay = dayFmt.format(new Date(Date.parse(input.endAt) - 1));
  if (input.status === "Confirmed") {
    if (
      !crew.active ||
      !crew.size ||
      !crew.dailyCapacityHours ||
      !crew.workingDays.length
    )
      throw new DomainError(
        409,
        "Configure this crew’s size, working days and daily capacity before confirming a booking.",
      );
    if (startDay !== endDay)
      throw new DomainError(
        400,
        "Split a multi-day installation into one booking per working day.",
      );
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: crew.timezone,
      weekday: "short",
    }).format(new Date(input.startAt));
    if (
      !crew.workingDays.includes(
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday),
      ) ||
      crew.unavailableDates.includes(startDay)
    )
      throw new DomainError(
        409,
        "This crew is unavailable on the selected day.",
      );
    if (input.plannedLaborHours > duration * crew.size + 0.000001)
      throw new DomainError(
        400,
        "Planned person-hours exceed the booking duration and crew size.",
      );
    const bookings = (
      await tx
        .select()
        .from(crewBookingsTable)
        .where(eq(crewBookingsTable.crewId, crew.id))
    ).filter((b) => b.id !== excludedBookingId && b.status === "Confirmed");
    const collision = bookings.find((b) => overlaps(input, b));
    if (collision)
      throw new DomainError(
        409,
        "This crew already has an overlapping booking.",
        { bookingId: collision.id },
      );
    const dailyHours = bookings
      .filter((b) => dayFmt.format(new Date(b.startAt)) === startDay)
      .reduce((sum, b) => sum + b.plannedLaborHours, 0);
    if (
      dailyHours + input.plannedLaborHours >
      crew.size * crew.dailyCapacityHours + 0.000001
    )
      throw new DomainError(
        409,
        "This booking exceeds the crew’s daily person-hour capacity.",
      );
  }

  return crew;
}
