import { useEffect, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Readiness = {
  checkedAt: string;
  setupStepsCompleted: number;
  setupStepCount: number;
  configurationExportAvailable: boolean;
  clientProductionAcceptanceComplete: false;
  steps: {
    key: string;
    title: string;
    state: "complete" | "missing" | "needs_review" | "acceptance_pending";
    detail: string;
    href: string;
  }[];
};
const labels = {
  complete: "Saved",
  missing: "Needs setup",
  needs_review: "Review needed",
  acceptance_pending: "Acceptance pending",
};

export function CompanySetup() {
  const { user } = useAuth();
  const allowed =
    !!user &&
    (user.actualRole ?? user.role) === "owner" &&
    user.role === "owner" &&
    !user.previewRole;
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<Readiness>();
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!allowed) {
      setData(undefined);
      setError("");
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    setMessage("");
    customFetch<Readiness>("/api/company-setup/readiness", {
      responseType: "json",
      signal: controller.signal,
    })
      .then((result) => {
        if (active) setData(result);
      })
      .catch(() => {
        if (active) {
          setData(undefined);
          setError(
            "Company setup could not be checked. Retry before relying on its status.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [allowed, user?.id, refresh]);
  if (!allowed) return null;
  const download = async () => {
    setExporting(true);
    setError("");
    setMessage("");
    let url: string | undefined;
    try {
      const blob = await customFetch<Blob>(
        "/api/company-setup/configuration-export",
        { responseType: "blob" },
      );
      url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "catalyst-works-company-configuration-v1.json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setMessage(
        "Company settings exported. Keep the file private and review any listed omissions.",
      );
    } catch {
      setError(
        "Company settings were not exported. Review saved settings or retry.",
      );
    } finally {
      if (url) URL.revokeObjectURL(url);
      setExporting(false);
    }
  };
  return (
    <Card aria-label="Company setup">
      <CardHeader>
        <CardTitle>Company setup</CardTitle>
        <CardDescription>
          Private onboarding based on saved company settings. Account
          connections and provider acceptance are separate steps.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={loading || exporting}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {loading ? "Checking setup…" : "Refresh setup"}
          </Button>
          <Button
            variant="outline"
            disabled={
              loading || exporting || !data?.configurationExportAvailable
            }
            onClick={() => void download()}
          >
            {exporting ? "Exporting…" : "Export company settings"}
          </Button>
        </div>
        {data && (
          <>
            <p className="text-sm">
              {data.setupStepsCompleted} of {data.setupStepCount} setup steps
              have saved configuration.
            </p>
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              Client and provider acceptance remain pending. Test data or saved
              credentials do not establish a completed client rollout.
            </p>
            <ul className="divide-y">
              {data.steps.map((step) => (
                <li key={step.key} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {step.href === "/inventory" ? (
                      <a
                        className="text-sm font-medium underline"
                        href="/inventory"
                      >
                        {step.title}
                      </a>
                    ) : (
                      <span className="text-sm font-medium">{step.title}</span>
                    )}
                    <span
                      className={
                        step.state === "complete"
                          ? "text-xs text-emerald-700"
                          : "text-xs text-amber-800"
                      }
                    >
                      {labels[step.state]}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{step.detail}</p>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="text-xs text-muted-foreground">
          The version 1 export contains business profile and supported operating
          settings. It excludes jobs, customers, suppliers, inventory, staff,
          files and provider connections. It is not a backup or a restore/import
          package.
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-800">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-emerald-800">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
