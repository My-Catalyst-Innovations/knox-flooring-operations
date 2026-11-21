import { Link } from "wouter";
import { DataBoundary } from "@/components/layout/DataBoundary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth";
import { useStore } from "@/hooks/use-store";
import { useUrlState } from "@/hooks/use-url-state";
import { contextualCreateHref } from "@/lib/create-context";
import { invoiceBalance } from "@/lib/invoices";
import { pendingJobDelivery, purchaseOrdersPath, type PurchaseOrder } from "@/lib/purchasing";
import {
  confirmedInstallationBookings,
  currency,
  installationBookingHref,
  jobsNeedingInstallation,
  useOperation,
  type Booking,
  type Crew,
} from "@/lib/operations";
import type { JobStatus } from "@/lib/types";

const phases = ["Sales", "Preparation", "Installation", "Closeout"] as const;
type Phase = typeof phases[number];
type Entry = {
  id: string;
  phase: Phase;
  title: string;
  reference?: string;
  stage: string;
  href: string;
  search: string;
  action: string;
  team: string;
  schedule?: string;
  materials?: string;
  blocker?: string;
  delivery?: { text: string; href: string };
  quote?: { label: string; href: string };
  invoice?: { label: string; href: string };
  accounting?: string;
  scheduleHref?: string;
  bookingHref?: string;
  workOrderHref?: string;
};

const workflow: Record<JobStatus, [Phase, string, string]> = {
  "New Lead": ["Sales", "Contact customer", "Sales"],
  "Estimate Scheduled": ["Sales", "Complete estimate", "Sales"],
  "Estimate Completed": ["Sales", "Prepare quote", "Sales"],
  "Proposal Sent": ["Sales", "Follow up on quote", "Sales"],
  Approved: ["Preparation", "Review material requirements", "Operations"],
  "Material Ordered": ["Preparation", "Confirm material arrival", "Operations"],
  "Material Received": ["Preparation", "Book the installation", "Operations"],
  Scheduled: ["Installation", "Review work order", "Installation crew"],
  "In Progress": ["Installation", "Record progress", "Installation crew"],
  "Final Walkthrough": ["Closeout", "Complete the walkthrough", "Installation crew"],
  Completed: ["Closeout", "Review the invoice", "Office"],
  Invoiced: ["Closeout", "Review payment", "Office"],
};

type AccountingEntry = { localId: string; entityType: string; status: string };
const accountingLabels: Record<string, string> = {
  pending_approval: "Pending approval",
  approved: "Approved for sync",
  processing: "Sync in progress",
  completed: "Synced",
  succeeded: "Synced",
  demo_completed: "Demo sync complete",
  retry: "Retry pending",
  failed: "Needs review",
  blocked: "Needs review",
};
const scheduleDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

function WorkflowCard({ entry }: { entry: Entry }) {
  return (
    <article className="min-w-0 space-y-2 rounded-md border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={entry.href} className="break-words font-semibold text-primary hover:underline">{entry.title}</Link>
          {entry.reference && <p className="text-xs text-muted-foreground">{entry.reference}</p>}
        </div>
        <Badge variant="outline">{entry.stage}</Badge>
      </div>
      <p>{entry.action} <span className="text-muted-foreground">· {entry.team}</span></p>
      {entry.schedule && <p className="text-muted-foreground">{entry.schedule}</p>}
      {entry.materials && <p className="text-muted-foreground">Materials · {entry.materials}</p>}
      {entry.blocker && <p className="rounded bg-amber-50 px-2 py-1 text-amber-950">{entry.blocker}</p>}
      {entry.delivery && <Link className="block text-muted-foreground underline" href={entry.delivery.href}>{entry.delivery.text}</Link>}
      {(entry.quote || entry.invoice || entry.accounting) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {entry.quote && <Link href={entry.quote.href} className="underline">{entry.quote.label}</Link>}
          {entry.invoice && <Link href={entry.invoice.href} className="underline">{entry.invoice.label}</Link>}
          {entry.accounting && <Link href="/settings" className="underline">QuickBooks · {entry.accounting}</Link>}
        </div>
      )}
      {(entry.scheduleHref || entry.bookingHref || entry.workOrderHref) && (
        <div className="flex flex-wrap gap-2">
          {entry.scheduleHref && <Button size="sm" variant="outline" asChild><Link href={entry.scheduleHref}>Schedule</Link></Button>}
          {entry.bookingHref && <Button size="sm" variant="outline" asChild><Link href={entry.bookingHref}>View booking</Link></Button>}
          {entry.workOrderHref && <Button size="sm" variant="outline" asChild><Link href={entry.workOrderHref}>Work order</Link></Button>}
        </div>
      )}
    </article>
  );
}

export default function Pipeline() {
  const { queryState, jobs, leads, proposals, invoices, materials } = useStore();
  const { user } = useAuth();
  const owner = user?.role === "owner";
  const sales = owner || user?.role === "sales";
  const operations = owner || user?.role === "operations";
  const bookings = useOperation<Booking[]>("/bookings", ["owner", "operations"]);
  const crews = useOperation<Crew[]>("/crews", ["owner", "operations"]);
  const accounting = useOperation<AccountingEntry[]>("/quickbooks/queue", ["owner"]);
  const purchaseOrders = useOperation<PurchaseOrder[]>(purchaseOrdersPath, ["owner", "operations"]);
  const [search, setSearch] = useUrlState<string>("q", "");
  const [view, setView] = useUrlState<"board" | "list">("view", "board");
  const bookingRecords = operations && !bookings.isError ? bookings.data : undefined;
  const readyToSchedule = new Set(bookingRecords ? jobsNeedingInstallation(jobs, bookingRecords).map((job) => job.id) : []);
  const now = Date.now();
  const upcomingByJob = new Map<string, Booking>();
  const previousByJob = new Map<string, Booking>();
  for (const booking of confirmedInstallationBookings(bookingRecords ?? [])) {
    if (Date.parse(booking.endAt) <= now) previousByJob.set(booking.jobId, booking);
    else if (!upcomingByJob.has(booking.jobId)) upcomingByJob.set(booking.jobId, booking);
  }
  const crewNames = new Map((crews.isError ? [] : crews.data ?? []).map((crew) => [crew.id, crew.name]));
  const pendingDeliveries = new Map<string, NonNullable<Entry["delivery"]>>();
  for (const order of [...purchaseOrders.data ?? []].sort(
    (left, right) => (left.expectedOn ?? "9999").localeCompare(right.expectedOn ?? "9999"),
  )) {
    const text = pendingJobDelivery(order);
    if (text && order.jobId && !pendingDeliveries.has(order.jobId))
      pendingDeliveries.set(order.jobId, { text, href: `${purchaseOrdersPath}?order=${encodeURIComponent(order.id)}` });
  }
  const entries: Entry[] = jobs.map((job) => {
    const [jobPhase, defaultNext, team] = workflow[job.status] ?? workflow.Approved;
    const booking = upcomingByJob.get(job.id);
    const previousBooking = previousByJob.get(job.id);
    const visibleBooking = booking ?? previousBooking;
    const crew = visibleBooking && crewNames.get(visibleBooking.crewId);
    const quote = sales ? proposals.filter((row) => row.convertedJobId === job.id || row.jobId === job.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] : undefined;
    const invoice = owner ? invoices.filter((row) => row.jobId === job.id && row.status !== "Voided")
      .sort((left, right) => right.issueDate.localeCompare(left.issueDate))[0] : undefined;
    const queueEntry = owner && (accounting.data ?? []).find((row) =>
      row.entityType === "invoice" ? row.localId === invoice?.id : row.entityType === "project" && row.localId === job.id,
    );
    const blocked = operations && materials.find((row) => row.jobId === job.id && (row.damaged || row.missingItems.trim() || row.status === "Delayed"));
    const bookedAfterMaterials = Boolean(booking && job.status === "Material Received" && !blocked);
    const phase = bookedAfterMaterials ? "Installation" : jobPhase;
    let next = defaultNext;
    if (bookedAfterMaterials) next = "Review work order";
    else if (job.status === "Material Received" && blocked) next = "Resolve material issue";
    else if (job.status === "Scheduled" && readyToSchedule.has(job.id)) next = "Rebook the installation";
    else if (!booking && previousBooking && ["Material Received", "Scheduled"].includes(job.status)) {
      next = "Review the previous booking";
    } else if (job.status === "Material Received" && operations && !bookingRecords) next = "Review installation readiness";
    const date = job.estStartDate ? `&date=${encodeURIComponent(job.estStartDate)}` : "";
    const schedule = visibleBooking
      ? `${booking ? "Confirmed" : "Previous booking"} · ${scheduleDate.format(new Date(visibleBooking.startAt))} ET${crew ? ` · ${crew}` : ""}`
      : job.estStartDate ? `Planned ${job.estStartDate}${job.crewAssigned && job.crewAssigned !== "Unassigned" ? ` · ${job.crewAssigned}` : ""}` : undefined;
    return {
      id: job.id, title: job.customerName, reference: job.jobNumber, stage: job.status, phase,
      team: bookedAfterMaterials ? "Installation crew" : team,
      href: `/jobs/${encodeURIComponent(job.id)}`,
      search: [job.customerName, job.jobNumber, job.city].join(" "),
      action: phase === "Closeout" && invoice?.status === "Paid" ? "Payment received" : next,
      schedule,
      materials: phase === "Preparation" || phase === "Installation" ? job.materialStatus : undefined,
      blocker: blocked ? blocked.damaged ? "Damaged materials" : blocked.missingItems.trim() ? `Missing materials: ${blocked.missingItems}` : "Material delivery delayed" : undefined,
      delivery: phase === "Preparation" || phase === "Installation" ? pendingDeliveries.get(job.id) : undefined,
      quote: quote && { label: `Quote · ${quote.status}`, href: `/proposals?proposal=${encodeURIComponent(quote.id)}` },
      invoice: invoice && { label: `Invoice · ${invoice.status}${invoiceBalance(invoice) > 0 && invoice.status !== "Draft" ? ` · ${currency(invoiceBalance(invoice))} due` : ""}`, href: `/invoices?invoice=${encodeURIComponent(invoice.id)}` },
      accounting: queueEntry ? accountingLabels[queueEntry.status] : undefined,
      scheduleHref: readyToSchedule.has(job.id) ? contextualCreateHref(`/calendar?create=1${date}`, { jobId: job.id }) : undefined,
      bookingHref: visibleBooking ? installationBookingHref(visibleBooking) : undefined,
      workOrderHref: phase === "Installation" ? `/jobs/${encodeURIComponent(job.id)}/work-order` : undefined,
    };
  });
  if (sales) {
    for (const lead of leads) {
      if (lead.convertedJobId || ["Won", "Lost"].includes(lead.stage)) continue;
      entries.push({
        id: `lead:${lead.id}`, phase: "Sales", title: lead.customerName, stage: lead.stage,
        action: "Review lead", team: lead.salesperson || "Sales", href: `/leads/${encodeURIComponent(lead.id)}`,
        search: [lead.customerName, lead.city].join(" "),
        schedule: lead.followUpDate ? `Follow up ${lead.followUpDate}` : undefined,
      });
    }
    const jobIds = new Set(jobs.map((job) => job.id));
    for (const quote of proposals) {
      if (jobIds.has(quote.jobId ?? "") || jobIds.has(quote.convertedJobId ?? "") || ["Declined", "Expired"].includes(quote.status)) continue;
      entries.push({
        id: `quote:${quote.id}`, phase: "Sales", title: quote.customerName, stage: `Quote · ${quote.status}`,
        action: quote.status === "Accepted" ? "Convert accepted quote" : quote.status === "Draft" ? "Review quote before sharing" : "Follow up on quote",
        team: "Sales", href: `/proposals?proposal=${encodeURIComponent(quote.id)}`,
        search: [quote.customerName, quote.projectLocation].join(" "),
      });
    }
  }
  const matches = entries.filter((entry) => entry.search.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <DataBoundary query={queryState.jobs} name="jobs">
      <div className="space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Job workflow</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Input className="w-60 max-w-full" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search workflow" placeholder="Search customer, job number, city" />
            <div role="group" aria-label="Workflow view" className="flex gap-1">
              <Button size="sm" variant="outline" aria-pressed={view !== "list"} onClick={() => setView("board")}>Board</Button>
              <Button size="sm" variant="outline" aria-pressed={view === "list"} onClick={() => setView("list")}>List</Button>
            </div>
          </div>
        </header>
        {operations && !bookingRecords && (
          <p role={bookings.isError ? "alert" : "status"} className="text-sm text-muted-foreground">
            {bookings.isError ? <>Booking status could not load. <button className="underline" onClick={() => void bookings.refetch()}>Retry bookings</button></> : "Loading booking status…"}
          </p>
        )}
        <div className={view === "list" ? "space-y-4" : "grid items-start gap-3 md:grid-cols-2 2xl:grid-cols-4"}>
          {phases.map((phase) => {
            const phaseEntries = matches.filter((entry) => entry.phase === phase);
            return (
              <section key={phase} className="min-w-0 rounded-lg border bg-muted/25 p-3" aria-label={phase}>
                <h2 className="mb-3 font-semibold">{phase} <span className="ml-1 text-xs text-muted-foreground">{phaseEntries.length}</span></h2>
                {phaseEntries.length ? (
                  <div className={view === "list" ? "grid gap-2 lg:grid-cols-2" : "space-y-2"}>
                    {phaseEntries.map((entry) => <WorkflowCard key={entry.id} entry={entry} />)}
                  </div>
                ) : <p className="text-sm text-muted-foreground">No matching records</p>}
              </section>
            );
          })}
        </div>
      </div>
    </DataBoundary>
  );
}
