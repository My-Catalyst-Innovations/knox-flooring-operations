import { Link, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { useOperation, quantity } from "@/lib/operations";
import type { Job, JobMaterial } from "@/lib/types";

interface WorkOrderContext {
  crews: { id: string; name: string }[];
  bookings: { id: string; crewId: string; startAt: string; endAt: string; status: string }[];
  materials: Pick<JobMaterial, "id" | "name" | "quantity" | "unit">[];
}

const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

export default function WorkOrder() {
  const { id = "" } = useParams();
  const path = `/jobs/${encodeURIComponent(id)}`;
  const job = useOperation<Job>(path);
  const context = useOperation<WorkOrderContext>(`${path}/entry-context`);
  const data = job.data;
  const bookings = (context.data?.bookings ?? []).filter((booking) => booking.status === "Confirmed")
    .sort((left, right) => left.startAt.localeCompare(right.startAt));

  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-5 p-5 sm:p-9 print:max-w-none print:p-0">
      <nav className="flex flex-wrap items-center justify-between gap-3 print:hidden" aria-label="Work order actions">
        <Button asChild variant="outline"><Link href={path}>Back to job</Link></Button>
        <Button disabled={!data || !context.data} onClick={() => window.print()}>Print work order</Button>
      </nav>
      {(job.isError || context.isError) && <p role="alert" className="text-sm text-destructive">The work order could not load. <button className="underline" onClick={() => { void job.refetch(); void context.refetch(); }}>Retry</button></p>}
      {!data ? <p role="status">Loading work order…</p> : (
        <>
          <header className="space-y-1 border-b pb-4">
            <h1 className="text-2xl font-semibold">Work order {data.jobNumber}</h1>
            <p>{data.customerName}</p>
            <p className="text-sm text-muted-foreground">{[data.address, data.city].filter(Boolean).join(", ")}</p>
          </header>
          <section className="space-y-2">
            <h2 className="font-semibold">Crew and schedule</h2>
            {context.isLoading ? <p>Loading crew bookings…</p> : bookings.length === 0 ? <p>No confirmed bookings.</p> : (
              <ul className="space-y-1 text-sm">
                {bookings.map((booking) => (
                  <li key={booking.id}>
                    {day.format(new Date(booking.startAt))} · {time.format(new Date(booking.startAt))}–{time.format(new Date(booking.endAt))} ET · {context.data?.crews.find((crew) => crew.id === booking.crewId)?.name ?? "Crew"}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="space-y-2">
            <h2 className="font-semibold">Scope</h2>
            <p className="whitespace-pre-wrap text-sm">{data.scopeOfWork || data.flooringType}</p>
            {!!data.rooms?.length && <ul className="space-y-1 text-sm">{data.rooms.map((room) => <li key={room.id}>{room.name} · {room.length} × {room.width} ft{room.scope ? ` · ${room.scope}` : ""}</li>)}</ul>}
          </section>
          <section className="space-y-2">
            <h2 className="font-semibold">Material requirements</h2>
            {context.isLoading ? <p>Loading materials…</p> : context.data?.materials.length ? (
              <ul className="space-y-1 text-sm">{context.data.materials.map((material) => <li key={material.id}>{material.name} · {quantity(material.quantity)} {material.unit}</li>)}</ul>
            ) : <p className="text-sm">No material requirements recorded.</p>}
          </section>
        </>
      )}
    </main>
  );
}
