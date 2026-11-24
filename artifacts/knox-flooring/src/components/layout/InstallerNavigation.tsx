import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth";

/** Installer navigation intentionally never imports the global workspace store. */
export function InstallerNavigation() {
  const { user, logout, switchPersona } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Your account action could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 print:hidden">
      <nav
        aria-label="Installer navigation"
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/work-guides">My work</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/profile">My profile</Link>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">
            {user?.previewRole
              ? "Previewing installer"
              : `Signed in as ${user?.name ?? "team member"}`}
          </span>
          {user?.actualRole === "owner" && user.previewRole === "installer" && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void act(() => switchPersona(null))}
            >
              Exit role preview
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void act(logout)}
          >
            Sign out
          </Button>
        </div>
      </nav>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
