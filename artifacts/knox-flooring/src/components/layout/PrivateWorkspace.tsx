import type { ReactNode } from "react";
import { Redirect, Route, Switch } from "wouter";
import { useAuth } from "@/contexts/auth";
import Profile from "@/pages/profile";
import { InstallerNavigation } from "./InstallerNavigation";

/** Effective installer role must never mount the office layout or its data store. */
export function PrivateWorkspace({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== "installer") return <>{children}</>;
  return (
    <Switch>
      <Route path="/profile">
        <main className="mx-auto min-h-screen max-w-4xl space-y-6 p-4 sm:p-8">
          <InstallerNavigation />
          <Profile />
        </main>
      </Route>
      <Route path="/jobs/:id">
        {(params) => (
          <Redirect to={`/work-guides?job=${encodeURIComponent(params.id)}`} />
        )}
      </Route>
      <Route>
        <Redirect to="/work-guides" />
      </Route>
    </Switch>
  );
}
