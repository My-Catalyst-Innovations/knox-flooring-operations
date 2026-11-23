import { useState } from "react";
import { Button } from "@/components/ui/button";
import { operation, useOperation } from "@/lib/operations";
import type { ProjectCapability } from "@/components/jobs/JobQuickBooksProject";

export function QuickBooksProjectsCapability() {
  const query = useOperation<ProjectCapability>(
    "/quickbooks/projects/capability",
    ["owner"],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!query.allowed) return null;
  const data = query.data;
  return (
    <div
      className="space-y-2 rounded-md border p-3 text-sm"
      aria-label="QuickBooks Projects capability"
    >
      <p className="font-medium">True QuickBooks Projects</p>
      {data?.connection && (
        <p>
          {data.connection.companyName} · {data.connection.environment}
        </p>
      )}
      <p role="status">
        {query.isError
          ? "Projects access could not be checked."
          : !data
            ? "Loading Projects capability…"
            : data.available
              ? "Projects access is verified for this company. Open a job to review its Project link."
              : data.reason ||
                "Connect a supported company and verify Projects access before linking jobs."}
      </p>
      <p className="text-muted-foreground">
        An existing legacy subcustomer link remains separate from a true
        Project.
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !data?.connection}
        onClick={() => {
          setBusy(true);
          setError("");
          void operation("/quickbooks/projects/probe", "POST", {
            connectionId: data!.connection!.id,
          })
            .then(() => query.refetch())
            .catch((cause) =>
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Projects verification failed.",
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        Verify Projects capability
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
