import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/contexts/auth";
import { operation, useOperation } from "@/lib/operations";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type Profile = { id: string; name: string; email: string; phone: string; jobTitle: string; role: string };
export default function ProfilePage() {
  const { user, refreshSession } = useAuth();
  const profile = useOperation<Profile>("/auth/profile");
  const [form, setForm] = useState({ name: "", phone: "", jobTitle: "" });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (profile.data && !dirty) setForm({ name: profile.data.name, phone: profile.data.phone, jobTitle: profile.data.jobTitle });
  }, [profile.data, dirty]);
  const set = (key: keyof typeof form, value: string) => { setDirty(true); setSaved(false); setForm(previous => ({ ...previous, [key]: value })); };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setSaved(false);
    try {
      await operation<Profile>("/auth/profile", "PATCH", form);
      await refreshSession();
      await profile.refetch();
      setDirty(false); setSaved(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Your profile could not be saved."); }
    finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
    <div><h1 className="text-2xl font-semibold">My profile</h1><p className="mt-1 text-muted-foreground">Keep your personal details up to date.</p></div>
    <Card><CardHeader><CardTitle>Personal details</CardTitle><CardDescription>Your sign-in email and access role identify your account.</CardDescription></CardHeader>
      <CardContent>{profile.isLoading ? <p>Loading your profile…</p> : profile.error ? <p role="alert">{profile.error instanceof Error ? profile.error.message : "Your profile could not be loaded."}</p> : <form className="space-y-4" onSubmit={save}>
        <div className="space-y-2"><Label htmlFor="profile-name">Full name</Label><Input id="profile-name" autoComplete="name" maxLength={150} required value={form.name} onChange={event => set("name", event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="profile-email">Sign-in email</Label><Input id="profile-email" type="email" value={profile.data?.email ?? ""} readOnly /></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="profile-phone">Phone</Label><Input id="profile-phone" type="tel" autoComplete="tel" maxLength={50} value={form.phone} onChange={event => set("phone", event.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="profile-title">Job title</Label><Input id="profile-title" autoComplete="organization-title" maxLength={100} value={form.jobTitle} onChange={event => set("jobTitle", event.target.value)} /></div>
        </div>
        <p className="text-sm text-muted-foreground">Access role: {profile.data?.role}</p>
        {user?.previewRole && <p role="alert" className="text-sm">Exit role preview to edit your profile.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {saved && <p role="status" className="text-sm">Profile saved.</p>}
        <Button type="submit" disabled={busy || !dirty || !form.name.trim() || Boolean(user?.previewRole)}>{busy ? "Saving…" : "Save profile"}</Button>
      </form>}</CardContent>
    </Card>
  </div>;
}
