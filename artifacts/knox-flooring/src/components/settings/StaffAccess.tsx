import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth, type AppRole } from "@/contexts/auth";
import { operation, useOperation } from "@/lib/operations";

const path = "/auth/staff";
const ownerRoles = ["owner"];
const roleLabels: Record<AppRole, string> = {
  owner: "Owner",
  operations: "Operations",
  sales: "Sales",
  installer: "Installer",
};
type StaffMember = {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  active: boolean;
  invitationPending: boolean;
};
type StaffInvitation = { staff: StaffMember; token: string; expiresAt: string };
const empty = { name: "", email: "", role: "operations" as AppRole };

export function StaffAccess() {
  const { user } = useAuth();
  if (!user || user.role !== "owner" || user.previewRole) return null;
  return <StaffRoster ownerId={user.id} />;
}

function StaffRoster({ ownerId }: { ownerId: string }) {
  const roster = useOperation<StaffMember[]>(path, ownerRoles);
  const [form, setForm] = useState(empty);
  const [invitation, setInvitation] = useState<{ url: string; id: string; name: string; expiresAt: string }>();
  const [target, setTarget] = useState<StaffMember>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  function showInvitation(result: StaffInvitation) {
    const url = new URL("/welcome", window.location.origin);
    url.hash = new URLSearchParams({ invite: result.token }).toString();
    setInvitation({ url: url.toString(), id: result.staff.id, name: result.staff.name, expiresAt: result.expiresAt });
  }

  async function update(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await action();
      await roster.refetch();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Staff access could not be updated.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    void update(async () => {
      const result = await operation<StaffInvitation>(`${path}/invitations`, "POST", form);
      showInvitation(result);
      setForm(empty);
    });
  }

  async function copy() {
    if (!invitation) return;
    setError("");
    try {
      await navigator.clipboard.writeText(invitation.url);
      setNotice("Invitation link copied.");
    } catch {
      setNotice("Select and copy the invitation link from the field.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Staff access</CardTitle>
        <CardDescription>Invite teammates with their own sign-in. Share the password setup link privately with the named recipient.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {roster.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading staff…</p>}
        {roster.isError && <p role="alert" className="text-sm text-destructive">{roster.error instanceof Error ? roster.error.message : "Staff accounts could not load."} <button className="underline" onClick={() => void roster.refetch()}>Retry</button></p>}
        {roster.data && !roster.isError && (
          <>
            <form className="space-y-3 rounded-md border p-3" onSubmit={create}>
              <fieldset className="grid gap-3 sm:grid-cols-3" disabled={busy}>
                <label className="space-y-1 text-sm font-medium">Full name
                  <Input required maxLength={150} autoComplete="off" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
                </label>
                <label className="space-y-1 text-sm font-medium">Work email
                  <Input required maxLength={254} type="email" autoComplete="off" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
                </label>
                <label className="space-y-1 text-sm font-medium">Access role
                  <select value={form.role} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" onChange={(event) => setForm({ ...form, role: event.target.value as AppRole })}>
                    {Object.entries(roleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
                  </select>
                </label>
              </fieldset>
              {form.role === "owner" && <p className="text-sm text-muted-foreground">Owners can manage staff, billing, and integrations.</p>}
              <Button type="submit" disabled={busy || !form.name.trim() || !form.email.trim()}>Create invitation</Button>
            </form>
            {invitation && (
              <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                <p className="text-sm font-semibold">Invitation for {invitation.name}</p>
                <p className="text-sm text-muted-foreground">One use. Expires {new Date(invitation.expiresAt).toLocaleString()}.</p>
                <Input readOnly aria-label="Invitation link" value={invitation.url} onFocus={(event) => event.currentTarget.select()} />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" type="button" onClick={() => void copy()}>Copy invitation link</Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => { setInvitation(undefined); setNotice(""); }}>Dismiss link</Button>
                </div>
              </div>
            )}
            <ul className="divide-y rounded-md border" aria-label="Staff accounts">
              {roster.data.map((member) => (
                <li key={member.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div className="min-w-0 break-words">
                    <p className="font-semibold">{member.name}{member.id === ownerId && " (you)"}</p>
                    <p className="text-muted-foreground">{member.email} · {roleLabels[member.role]} · {member.active ? "Active" : member.invitationPending ? "Invited" : "Inactive"}</p>
                  </div>
                  {member.id !== ownerId && <div className="flex flex-wrap gap-2">
                    {!member.active && <Button size="sm" variant="outline" disabled={busy} aria-label={`Create new invite for ${member.name}`} onClick={() => void update(async () => {
                      const result = await operation<StaffInvitation>(`${path}/${encodeURIComponent(member.id)}/invitation`, "POST");
                      showInvitation(result);
                    })}>{member.invitationPending ? "Replace link" : "Reinvite"}</Button>}
                    {(member.active || member.invitationPending) && <Button size="sm" variant="ghost" disabled={busy} aria-label={`${member.active ? "Deactivate" : "Cancel invitation for"} ${member.name}`} onClick={() => { setError(""); setTarget(member); }}>{member.active ? "Deactivate" : "Cancel invitation"}</Button>}
                  </div>}
                </li>
              ))}
            </ul>
          </>
        )}
        {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
        {error && !target && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {target && <Dialog open onOpenChange={(open) => { if (!open && !inFlight.current) { setTarget(undefined); setError(""); } }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{target.active ? `Deactivate access for ${target.name}?` : `Cancel the invitation for ${target.name}?`}</DialogTitle>
              <DialogDescription>{target.active ? "This ends their sessions and blocks sign-in. You can invite them again later." : "The current invitation link will stop working."}</DialogDescription>
            </DialogHeader>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => { setTarget(undefined); setError(""); }}>Keep access</Button>
              <Button variant="destructive" disabled={busy} onClick={() => void update(async () => {
                await operation(`${path}/${encodeURIComponent(target.id)}/deactivate`, "POST");
                if (invitation?.id === target.id) setInvitation(undefined);
                setNotice(target.active ? "Staff access deactivated." : "Invitation cancelled.");
                setTarget(undefined);
              })}>{target.active ? "Deactivate access" : "Cancel invitation"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>}
      </CardContent>
    </Card>
  );
}
