import { useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/contexts/auth";
import { useQueryControls, useUrlState } from "@/hooks/use-url-state";
import { operation, useOperation } from "@/lib/operations";
import type { GuideJob, WorkGuide, WorkGuideStep } from "@/lib/work-guides";

const roles = ["owner", "operations", "installer"];
const selectClass =
  "min-h-11 w-full rounded-md border bg-background px-3 text-sm";

function OutcomeSteps({
  title,
  steps,
}: {
  title: string;
  steps: WorkGuideStep[];
}) {
  return (
    <section className="space-y-3" aria-label={title}>
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">
        {steps.filter((step) => step.verified).length} of {steps.length} saved
        outcomes verified
      </p>
      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li
            key={step.key}
            className="space-y-2 rounded-lg border bg-card p-4"
          >
            <h3 className="font-semibold">
              {index + 1}. {step.title}
            </h3>
            <p className="text-sm">{step.instruction}</p>
            <p
              className={`text-sm ${step.verified ? "text-emerald-800" : "text-muted-foreground"}`}
            >
              <strong>
                {step.verified
                  ? "Saved outcome verified"
                  : "Awaiting saved evidence"}
                :
              </strong>{" "}
              {step.evidence}
            </p>
            {step.href && step.actionLabel && (
              <Button asChild variant="outline" size="sm">
                <Link href={step.href}>{step.actionLabel}</Link>
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function FieldUpdate({ jobId, onSaved }: { jobId: string; onSaved(): void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const attempt = useRef<{ id: string; message: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || pending.current) return;
    if (attempt.current?.message !== text)
      attempt.current = { id: crypto.randomUUID(), message: text };
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation(
        `/work-guides/jobs/${encodeURIComponent(jobId)}/updates`,
        "POST",
        attempt.current,
      );
      setMessage("");
      attempt.current = null;
      setNotice("Your job update was saved for the team.");
      onSaved();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Your update could not be saved.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Save a field update"
      className="space-y-3 rounded-lg border p-4"
    >
      <h2 className="font-semibold">Save a field update</h2>
      <p className="text-sm text-muted-foreground">
        This saves a real job update for your team. It does not change the job
        stage or mark this guide complete.
      </p>
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <label className="block space-y-1 text-sm">
          Work performed, issue or handoff
          <Textarea
            maxLength={1500}
            required
            disabled={busy}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={busy || !message.trim()}>
          {busy ? "Saving…" : "Save job update"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}

/** No global useStore/AppLayout fetches: installer data comes only from scoped guide APIs. */
export default function WorkGuides() {
  const { user, logout } = useAuth();
  const [jobId] = useUrlState<string>("job", "");
  const [orderId, setOrderId] = useUrlState<string>("order", "");
  const controls = useQueryControls();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const jobs = useOperation<{
    jobs: GuideJob[];
    hasMore: boolean;
    assignmentRequired: boolean;
  }>(
    `/work-guides/jobs${query ? `?q=${encodeURIComponent(query)}` : ""}`,
    roles,
  );
  const detailPath = `/work-guides/jobs/${encodeURIComponent(jobId)}${orderId ? `?order=${encodeURIComponent(orderId)}` : ""}`;
  const detail = useOperation<WorkGuide>(detailPath, jobId ? roles : []);
  const data = detail.isError ? undefined : detail.data;
  const installer = user?.role === "installer";
  if (!user || !roles.includes(user.role))
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-semibold">Work guides</h1>
        <p className="mt-3">
          Work guides are available to owner, operations and installer roles.
        </p>
        <Link href="/">Return to workspace</Link>
      </main>
    );
  function chooseJob(value: string) {
    controls.update({ job: value, order: null });
  }
  return (
    <main className="mx-auto min-h-screen max-w-4xl space-y-6 p-4 sm:p-8">
      <nav
        aria-label="Guide navigation"
        className="flex flex-wrap items-center justify-between gap-3"
      >
        {!installer ? (
          <Button asChild variant="outline">
            <Link href="/">Back to workspace</Link>
          </Button>
        ) : (
          <span className="text-sm">Signed in as {user.name}</span>
        )}
        <Button variant="ghost" onClick={() => void logout()}>
          Sign out
        </Button>
      </nav>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Work guides</h1>
        <p>
          Follow real warehouse and installation work, with progress checked
          against saved records.
        </p>
        <p className="text-sm text-muted-foreground">
          Opening or refreshing a guide creates no business records. Existing
          team work may already satisfy a step. These checks are not a training
          certificate or proof that you personally performed the work.
        </p>
      </header>
      <section
        className="space-y-3 rounded-lg border p-4"
        aria-label="Select real work"
      >
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(search.trim());
          }}
        >
          <label className="flex-1 space-y-1 text-sm">
            Find a job
            <Input
              value={search}
              maxLength={80}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Job number or customer"
            />
          </label>
          <Button variant="outline" type="submit">
            Search jobs
          </Button>
        </form>
        <label className="block space-y-1 text-sm">
          {installer ? "Your assigned job" : "Job"}
          <select
            className={selectClass}
            value={jobId}
            onChange={(event) => chooseJob(event.target.value)}
          >
            <option value="">Select saved work…</option>
            {jobId && !jobs.data?.jobs.some((job) => job.id === jobId) && (
              <option value={jobId}>
                {data
                  ? `${data.job.jobNumber} · ${data.job.customerName}`
                  : "Selected job"}
              </option>
            )}
            {jobs.data?.jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.jobNumber} · {job.customerName} · {job.status}
              </option>
            ))}
          </select>
        </label>
        {jobs.isLoading && <p role="status">Loading accessible jobs…</p>}
        {jobs.isError && (
          <p role="alert">
            Accessible jobs could not load.{" "}
            <button className="underline" onClick={() => void jobs.refetch()}>
              Retry
            </button>
          </p>
        )}
        {jobs.data?.hasMore && (
          <p className="text-sm">
            Showing the first 100 matches. Search by job number to narrow the
            list.
          </p>
        )}
        {jobs.data && !jobs.data.jobs.length && (
          <p className="text-sm">
            {installer
              ? "No matching job is explicitly assigned to your account. Ask operations to assign you a non-cancelled task linked to the job; a crew name alone does not grant access."
              : "No saved jobs match. Select legitimate work after your team creates it through the normal workflow."}
          </p>
        )}
      </section>
      {jobId && detail.isLoading && (
        <p role="status">Checking saved outcomes…</p>
      )}
      {jobId && detail.isError && (
        <p role="alert">
          This job could not be loaded or is no longer accessible.{" "}
          <button className="underline" onClick={() => void detail.refetch()}>
            Recheck access
          </button>
        </p>
      )}
      {data && (
        <>
          <section className="space-y-2 border-b pb-4">
            <h2 className="text-xl font-semibold">
              {data.job.jobNumber} · {data.job.customerName}
            </h2>
            <p className="text-sm">
              {[data.job.address, data.job.city].filter(Boolean).join(", ")}
            </p>
            <p className="whitespace-pre-wrap text-sm">
              {data.job.scopeOfWork || data.job.flooringType}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => void detail.refetch()}
                disabled={detail.isFetching}
              >
                Refresh saved evidence
              </Button>
              <Button asChild variant="outline">
                <Link
                  href={`/jobs/${encodeURIComponent(data.job.id)}/work-order`}
                >
                  Open work order
                </Link>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Last checked {new Date(data.checkedAt).toLocaleString()}.
              Corrections, returns and reopened work can change the result.
            </p>
          </section>
          {!installer && (
            <section className="space-y-3">
              <label className="block space-y-1 text-sm">
                Warehouse purchase order
                <select
                  className={selectClass}
                  value={data.selectedOrderId ?? ""}
                  onChange={(event) => setOrderId(event.target.value)}
                >
                  <option value="">Select this job's order…</option>
                  {data.orders.map((order) => (
                    <option key={order.id} value={order.id}>
                      PO-{order.number} · {order.supplier} ·{" "}
                      {order.warehouseName} · {order.status}
                    </option>
                  ))}
                </select>
              </label>
              {!data.orders.length && (
                <p className="text-sm">
                  No purchase order is linked to this job. Use an existing
                  legitimate order or create one through purchase orders when
                  needed.
                </p>
              )}
              {data.warehouse && (
                <OutcomeSteps
                  title="Warehouse: receive, locate and issue"
                  steps={data.warehouse}
                />
              )}
            </section>
          )}
          <OutcomeSteps
            title="Installation and closeout"
            steps={data.installation}
          />
          <FieldUpdate
            key={data.job.id}
            jobId={data.job.id}
            onSaved={() => void detail.refetch()}
          />
          {!!data.ownUpdates.length && (
            <section className="space-y-2" aria-label="Your saved updates">
              <h2 className="font-semibold">Your saved updates</h2>
              <ol className="divide-y">
                {data.ownUpdates.map((update) => (
                  <li key={update.id} className="py-2">
                    <p className="text-xs text-muted-foreground">
                      {new Date(update.createdAt).toLocaleString()}
                    </p>
                    <p className="whitespace-pre-wrap text-sm">
                      {update.message}
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </main>
  );
}
