import { CalendarDays } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { contextualCreateHref } from "@/lib/create-context";
import {
  confirmedInstallationBookings,
  installationBookingHref,
  jobsNeedingInstallation,
  useOperation,
  type Booking,
} from "@/lib/operations";
import type { Job } from "@/lib/types";

export function JobInstallationAction({ job }: { job: Job }) {
  const params = new URLSearchParams({ jobId: job.id });
  const bookings = useOperation<Booking[]>(`/bookings?${params}`, [
    "owner",
    "operations",
  ]);
  if (!bookings.allowed || bookings.isError || !bookings.data) return null;

  const jobBookings = bookings.data.filter(({ jobId }) => jobId === job.id);
  const confirmed = confirmedInstallationBookings(jobBookings);
  const now = Date.now();
  const booking =
    confirmed.find(({ endAt }) => Date.parse(endAt) > now) ?? confirmed.at(-1);
  if (booking) {
    return (
      <Button variant="outline" asChild>
        <Link href={installationBookingHref(booking)}>
          <CalendarDays aria-hidden="true" /> View installation booking
        </Link>
      </Button>
    );
  }
  if (!jobsNeedingInstallation([job], jobBookings).length) return null;

  const date = job.estStartDate
    ? `&date=${encodeURIComponent(job.estStartDate)}`
    : "";
  const href = contextualCreateHref(`/calendar?create=1${date}`, {
    jobId: job.id,
  });
  return (
    <Button asChild>
      <Link href={href}>
        <CalendarDays aria-hidden="true" /> Schedule installation
      </Link>
    </Button>
  );
}
