import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/auth";
import { operation, useOperation } from "@/lib/operations";
import { Button } from "@/components/ui/button";

type Assignment = {
  taskId: string;
  jobId: string;
  bookingId: string;
  assigneeId: string | null;
  updatedAt: string;
  bookingRevision: number;
};
type Staff = { id: string; name: string; role: string };

export function TaskStaffAssignment({ taskId }: { taskId: string }) {
  const { user } = useAuth();
  const allowed =
    !!user && !user.previewRole && ["owner", "operations"].includes(user.role);
  const roles = allowed ? ["owner", "operations"] : [];
  const staff = useOperation<Staff[]>("/tasks/assignees", roles);
  const assignment = useOperation<Assignment>(
    `/tasks/${encodeURIComponent(taskId)}/assignment`,
    roles,
  );
  const [assigneeId, setAssigneeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setAssigneeId(assignment.data?.assigneeId ?? "");
  }, [assignment.data?.assigneeId]);
  if (!allowed) return null;
  async function save() {
    if (!assignment.data || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation(
        `/tasks/${encodeURIComponent(taskId)}/assignment`,
        "PATCH",
        {
          assigneeId: assigneeId || null,
          updatedAt: assignment.data.updatedAt,
          bookingRevision: assignment.data.bookingRevision,
        },
      );
      await assignment.refetch();
      setMessage("Staff assignment saved. No calendar or message was sent.");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The assignment could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="space-y-2 rounded-lg border p-3"
      aria-label="Installation staff access"
    >
      <h3 className="font-medium">Installation staff access</h3>
      <p className="text-sm text-muted-foreground">
        Assign a signed-in teammate to this installation task. This grants
        access to this job's operational work. Crew membership is not inferred.
      </p>
      {staff.isError || assignment.isError ? (
        <p role="alert">
          Staff or assignment could not load.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              void staff.refetch();
              void assignment.refetch();
            }}
          >
            Refresh assignment
          </button>
        </p>
      ) : (
        <>
          <label className="block space-y-1 text-sm">
            Assigned staff
            <select
              className="h-11 w-full rounded-lg border bg-background px-3 text-sm"
              value={assigneeId}
              disabled={busy || !staff.data || !assignment.data}
              onChange={(event) => setAssigneeId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {assigneeId &&
                !staff.data?.some((person) => person.id === assigneeId) && (
                  <option value={assigneeId}>
                    Previously assigned staff (unavailable)
                  </option>
                )}
              {staff.data?.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name} · {person.role}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={
              busy ||
              !assignment.data ||
              !staff.data ||
              assigneeId === (assignment.data.assigneeId ?? "")
            }
            onClick={() => void save()}
          >
            {busy ? "Saving assignment…" : "Save staff assignment"}
          </Button>
        </>
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
    </section>
  );
}
