import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { operation, useOperation } from "@/lib/operations";
import { inventorySelect } from "@/lib/purchasing";

interface ProjectConnection {
  id: string;
  realmId: string;
  environment: string;
  companyName: string;
}
export interface ProjectCapability {
  connection: ProjectConnection | null;
  available: boolean;
  reason: string | null;
  scopeGranted: boolean;
  preferenceEnabled: boolean;
  probeSucceeded: boolean;
  requestScopeEnabled?: boolean;
}
interface Project {
  id: string;
  name: string;
  status: string;
  customerId: string;
}
interface ProjectReview {
  id: string;
  jobId: string;
  connectionId: string;
  revision: number;
  fingerprint: string;
  status:
    | "pending_approval"
    | "submitting"
    | "unknown"
    | "linked"
    | "failed"
    | "cancelled";
  name: string;
  description: string;
  lastError: string | null;
  submittedAt: string | null;
  quickbooksProjectId: string | null;
}
interface ProjectData {
  connection: ProjectConnection | null;
  capability: ProjectCapability;
  job: { id: string; jobNumber: string; revision: number; updatedAt: string };
  customer: { id: string; name: string } | null;
  link: {
    kind: "qbo_project";
    projectId: string;
    projectName: string;
    projectStatus: string;
    revision: number;
    customerId: string;
  } | null;
  legacySubcustomer: { id: string; name?: string } | null;
  review: ProjectReview | null;
}
export function JobQuickBooksProject({ jobId }: { jobId: string }) {
  const base = `/quickbooks/projects/jobs/${encodeURIComponent(jobId)}`;
  const query = useOperation<ProjectData>(base, ["owner"]);
  const [candidates, setCandidates] = useState<Project[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const data = query.data;
  const connectionId = data?.connection?.id;
  useEffect(() => {
    setCandidates([]);
    setSelected("");
    setConfirmed(false);
  }, [
    connectionId,
    data?.customer?.id,
    data?.job.revision,
    data?.job.updatedAt,
  ]);
  useEffect(() => {
    setConfirmed(false);
  }, [data?.review?.id, data?.review?.revision, data?.review?.fingerprint]);
  if (!query.allowed) return null;
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The Project could not be reviewed.",
      );
    } finally {
      setBusy(false);
    }
  }
  const request = () => ({ connectionId, jobRevision: data!.job.revision });
  const review = data?.review;
  const canLink =
    !review ||
    ["pending_approval", "linked", "cancelled"].includes(review.status);
  const canCreate =
    !data?.link &&
    (!review || ["pending_approval", "cancelled"].includes(review.status));
  const uncertain =
    review && ["submitting", "unknown", "failed"].includes(review.status);
  return (
    <Card>
      <CardHeader>
        <CardTitle>QuickBooks Project</CardTitle>
        <CardDescription>
          Link this job to a verified Project belonging to its QuickBooks
          customer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading && <p role="status">Loading Project connection…</p>}
        {query.isError && (
          <p role="alert">
            Project details could not be loaded. Refresh to try again.
          </p>
        )}
        {data?.connection && (
          <p className="text-sm">
            {data.connection.companyName} · {data.connection.environment} ·
            Company {data.connection.realmId}
          </p>
        )}
        {data?.legacySubcustomer && (
          <p className="text-sm text-muted-foreground">
            Existing legacy subcustomer:{" "}
            {data.legacySubcustomer.name || data.legacySubcustomer.id}. This is
            separate from a QuickBooks Project.
          </p>
        )}
        {data?.link && (
          <p className="rounded-md border p-3 text-sm">
            Linked Project: <strong>{data.link.projectName}</strong> ·{" "}
            {data.link.projectStatus} · ID {data.link.projectId}
          </p>
        )}
        {data && !data.capability.available && (
          <p role="status" className="text-sm">
            {data.capability.reason ||
              "Projects is not available for this connection."}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void query.refetch()}
          >
            Refresh Project
          </Button>
          {connectionId && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await operation("/quickbooks/projects/probe", "POST", {
                    connectionId,
                  });
                  await query.refetch();
                })
              }
            >
              Verify Projects access
            </Button>
          )}
          {data?.capability.requestScopeEnabled &&
            !data.capability.scopeGranted && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                  const result = await operation<{ authorizationUrl: string }>(
                      "/quickbooks/connect?projects=true",
                    );
                  const url = new URL(result.authorizationUrl);
                    if (
                      url.protocol !== "https:" ||
                      url.hostname !== "appcenter.intuit.com"
                    )
                      throw new Error(
                        "The QuickBooks authorization page could not be verified.",
                      );
                    window.location.assign(url.href);
                  })
                }
              >
                Enable Projects permission
              </Button>
            )}
        </div>
        {data?.capability.available && !data.customer && (
          <p className="text-sm">
            Link this job's customer to QuickBooks before selecting or creating
            a Project.
          </p>
        )}
        {data?.capability.available && data.customer && (
          <fieldset disabled={busy} className="space-y-4">
            <p className="text-sm">
              Verified customer: <strong>{data.customer.name}</strong> · ID{" "}
              {data.customer.id}
            </p>
            <label className="block space-y-1 text-sm">
              Owner approval note
              <Input
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                  setConfirmed(false);
                }}
                maxLength={1000}
              />
            </label>
            {canLink && (
              <>
                <Button
                  variant="outline"
                  onClick={() =>
                    void run(async () => {
                      setCandidates([]);
                      setSelected("");
                      const result = await operation<{
                        projects: Project[];
                        complete: boolean;
                      }>(
                        `${base}/candidates?connectionId=${encodeURIComponent(connectionId!)}`,
                      );
                      if (!result.complete)
                        throw new Error(
                          "The complete Project list could not be verified. No Project can be selected yet.",
                        );
                      setCandidates(result.projects);
                      setSelected("");
                    })
                  }
                >
                  Load matching Projects
                </Button>
                {candidates.length > 0 && (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="space-y-1 text-sm">
                      Existing Project
                      <select
                        aria-label="Existing QuickBooks Project"
                        className={inventorySelect}
                        value={selected}
                        onChange={(event) => setSelected(event.target.value)}
                      >
                        <option value="">Select a verified Project</option>
                        {candidates.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name} · {project.status} · {project.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      disabled={!selected || !note.trim()}
                      onClick={() =>
                        void run(async () => {
                          await operation(`${base}/link`, "PUT", {
                            ...request(),
                            projectId: selected,
                            ...(data.link
                              ? { linkRevision: data.link.revision }
                              : {}),
                            note: note.trim(),
                          });
                          setCandidates([]);
                          await query.refetch();
                          setMessage("Project link saved.");
                        })
                      }
                    >
                      Approve selected Project link
                    </Button>
                  </div>
                )}
                {canCreate && (
                  <div className="space-y-3 rounded-md border p-3">
                    <p className="font-medium text-sm">
                      {review?.status === "pending_approval"
                        ? "Revise unsubmitted Project draft"
                        : "Create a new Project"}
                    </p>
                    {review?.status === "pending_approval" && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          const marker = `Catalyst Works project reference ${review.id}`;
                          setName(review.name);
                          setDescription(
                            review.description.endsWith(marker)
                              ? review.description
                                  .slice(0, -marker.length)
                                  .trimEnd()
                              : review.description,
                          );
                          setConfirmed(false);
                        }}
                      >
                        Edit draft details
                      </Button>
                    )}
                    <label className="block space-y-1 text-sm">
                      Project name
                      <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={100}
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      Project description
                      <Input
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        maxLength={1000}
                      />
                    </label>
                    <Button
                      variant="outline"
                      disabled={!name.trim()}
                      onClick={() =>
                        void run(async () => {
                          await operation(`${base}/create-review`, "POST", {
                            ...request(),
                            name: name.trim(),
                            description: description.trim(),
                          });
                          await query.refetch();
                          setConfirmed(false);
                        })
                      }
                    >
                      {review?.status === "pending_approval"
                        ? "Save revised Project review"
                        : "Prepare Project review"}
                    </Button>
                  </div>
                )}
              </>
            )}
            {review && (
              <div className="space-y-3 rounded-md border p-3 text-sm">
                <p className="font-medium">
                  Project request · {review.status.replaceAll("_", " ")}
                </p>
                <p>{review.name}</p>
                <p className="whitespace-pre-wrap">{review.description}</p>
                {review.lastError && <p role="alert">{review.lastError}</p>}
                {review.status === "pending_approval" && (
                  <>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      I approve this exact new Project and customer in{" "}
                      {data.connection!.companyName} (
                      {data.connection!.environment}).
                    </label>
                    <Button
                      disabled={!confirmed || !note.trim()}
                      onClick={() =>
                        void run(async () => {
                          await operation(
                            `/quickbooks/projects/reviews/${encodeURIComponent(review.id)}/submit`,
                            "POST",
                            {
                              connectionId,
                              reviewRevision: review.revision,
                              fingerprint: review.fingerprint,
                              note: note.trim(),
                            },
                          );
                          setConfirmed(false);
                          await query.refetch();
                          setMessage(
                            "Project result refreshed. Check its status before any further action.",
                          );
                        })
                      }
                    >
                      Approve and create Project
                    </Button>
                  </>
                )}
                {uncertain && (
                  <>
                    <p>
                      Check the original request in QuickBooks before
                      considering another creation.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void run(async () => {
                          await operation(
                            `/quickbooks/projects/reviews/${encodeURIComponent(review.id)}/reconcile`,
                            "POST",
                            { connectionId, reviewRevision: review.revision },
                          );
                          await query.refetch();
                        })
                      }
                    >
                      Reconcile previous Project request
                    </Button>
                  </>
                )}
              </div>
            )}
          </fieldset>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
