import { Link, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { useOperation, quantity } from "@/lib/operations";
import { useAuth } from "@/contexts/auth";
import type { SafeWorkOrder } from "@/lib/work-guides";

const day = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const time = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});

export default function WorkOrder() {
  const { id = "" } = useParams();
  const path = `/jobs/${encodeURIComponent(id)}`;
  const { user } = useAuth();
  const job = useOperation<SafeWorkOrder>(`/work-guides${path}/work-order`);
  const data = job.isError ? undefined : job.data?.job;
  const bookings = (job.data?.bookings ?? []).sort((left, right) =>
    left.startAt.localeCompare(right.startAt),
  );

  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-5 p-5 sm:p-9 print:max-w-none print:p-0">
      <nav
        className="flex flex-wrap items-center justify-between gap-3 print:hidden"
        aria-label="Work order actions"
      >
        <Button asChild variant="outline">
          <Link
            href={
              user?.role === "installer"
                ? `/work-guides?job=${encodeURIComponent(id)}`
                : path
            }
          >
            {user?.role === "installer" ? "Back to work guide" : "Back to job"}
          </Link>
        </Button>
        <Button disabled={!data} onClick={() => window.print()}>
          Print work order
        </Button>
      </nav>
      {job.isError && (
        <p role="alert" className="text-sm text-destructive">
          The work order could not load or is no longer accessible.{" "}
          <button className="underline" onClick={() => void job.refetch()}>
            Retry
          </button>
        </p>
      )}
      {!data ? (
        <p role="status">Loading work order…</p>
      ) : (
        <>
          <header className="space-y-1 border-b pb-4">
            <h1 className="text-2xl font-semibold">
              Work order {data.jobNumber}
            </h1>
            <p>{data.customerName}</p>
            <p className="text-sm text-muted-foreground">
              {[data.address, data.city].filter(Boolean).join(", ")}
            </p>
          </header>
          <section className="space-y-2">
            <h2 className="font-semibold">Crew and schedule</h2>
            {bookings.length === 0 ? (
              <p>No confirmed crew booking is available to your account.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {bookings.map((booking) => (
                  <li key={booking.id}>
                    {day.format(new Date(booking.startAt))} ·{" "}
                    {time.format(new Date(booking.startAt))}–
                    {time.format(new Date(booking.endAt))} ET ·{" "}
                    {booking.crewName}
                  </li>
                ))}
              </ul>
            )}
            {!!job.data?.tasks.length && (
              <ul className="space-y-1 text-sm">
                {job.data.tasks.map((task) => (
                  <li key={task.id}>
                    {task.title} · {day.format(new Date(task.startAt))} ·{" "}
                    {time.format(new Date(task.startAt))}–
                    {time.format(new Date(task.endAt))} ET · {task.status}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="space-y-2">
            <h2 className="font-semibold">Scope</h2>
            <p className="whitespace-pre-wrap text-sm">
              {data.scopeOfWork || data.flooringType}
            </p>
            {!!data.rooms?.length && (
              <ul className="space-y-1 text-sm">
                {data.rooms.map((room) => (
                  <li key={room.id}>
                    {room.name} · {room.length} × {room.width} ft
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="space-y-2">
            <h2 className="font-semibold">Material requirements</h2>
            {job.data?.materials.length ? (
              <ul className="space-y-1 text-sm">
                {job.data.materials.map((material) => (
                  <li key={material.id}>
                    {material.name} · {quantity(material.quantity)}{" "}
                    {material.unit}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm">No material requirements recorded.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
