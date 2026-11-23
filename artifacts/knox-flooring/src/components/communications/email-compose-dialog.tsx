import { useEffect, useId, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Mail } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { communicationStatus } from "@/lib/communication-status";
import type { Communication } from "@/lib/types";
import { operation } from "@/lib/operations";

interface EmailSendStatus {
  outlook: { connected: boolean; mailboxEmail: string | null };
  resend: { configured: boolean };
  mode: "capture" | "allowlist" | "live";
}

interface EmailComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefilled recipient email address from the lead/customer. */
  toAddress: string;
  customerName?: string;
  defaultSubject?: string;
  defaultBody?: string;
  onSend: (input: {
    to: string;
    subject: string;
    body: string;
    customerName?: string;
    idempotencyKey: string;
    provider?: "resend" | "outlook";
  }) => Promise<Communication>;
}

export function EmailComposeDialog({
  open,
  onOpenChange,
  toAddress,
  customerName,
  defaultSubject = "",
  defaultBody = "",
  onSend,
}: EmailComposeDialogProps) {
  const { toast } = useToast();
  const [to, setTo] = useState(toAddress);
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [sending, setSending] = useState(false);
  const [provider, setProvider] = useState<"resend" | "outlook">("resend");
  const [sendStatus, setSendStatus] = useState<EmailSendStatus | null>(null);
  const pending = useRef(false);
  const attempt = useRef<{ fingerprint: string; key: string }>(null);
  const formId = useId();

  useEffect(() => {
    let active = true;
    if (open) {
      setTo(toAddress);
      setSubject(defaultSubject);
      setBody(defaultBody);
      setSendStatus(null);
      if (!attempt.current) setProvider("resend");
      void operation<EmailSendStatus>("/communications/email/status")
        .then((status) => { if (active) setSendStatus(status); })
        .catch(() => { if (active) setSendStatus(null); });
    }
    return () => { active = false; };
    // Reset the form to the prefilled values each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const outlookReady = Boolean(sendStatus?.outlook.connected);

  const handleSend = async () => {
    if (pending.current) return;
    if (provider === "outlook" && !outlookReady) {
      toast({ title: "Connect Outlook email in Settings before sending", variant: "destructive" });
      return;
    }
    if (!to.trim()) {
      toast({ title: "Recipient email is required", variant: "destructive" });
      return;
    }
    if (!subject.trim() || !body.trim()) {
      toast({
        title: "Subject and message are required",
        variant: "destructive",
      });
      return;
    }
    pending.current = true;
    setSending(true);
    try {
      const input = { to: to.trim(), subject: subject.trim(), body, customerName, provider };
      const fingerprint = JSON.stringify(input);
      if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
      const result = await onSend({ ...input, idempotencyKey: attempt.current.key });
      const failed = result.status === "failed";
      const unconfirmed = result.status === "unknown" || (result.status === "queued" && !result.providerMessageId);
      toast({ title: communicationStatus(result), description: result.errorMessage ?? undefined, ...(failed || unconfirmed ? { variant: "destructive" as const } : {}) });
      if (!unconfirmed) attempt.current = null;
      if (!failed && !unconfirmed) onOpenChange(false);
    } catch (err) {
      toast({
        title: "Email submission not confirmed",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      pending.current = false;
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending.current) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="w-5 h-5" /> Compose Email
          </DialogTitle>
          <DialogDescription>
            {customerName ? `Send an email to ${customerName}.` : "Send an email."}
          </DialogDescription>
        </DialogHeader>
        <form id={formId} className="space-y-4" onSubmit={(event) => { event.preventDefault(); void handleSend(); }}>
          <div className="space-y-2">
            <Label htmlFor={`${formId}-sender`}>Send using</Label>
            <select
              id={`${formId}-sender`}
              className="block h-10 w-full rounded-md border bg-background px-3 text-sm"
              disabled={sending}
              value={provider}
              onChange={(event) => setProvider(event.target.value as "resend" | "outlook")}
            >
              <option value="resend">Company email service</option>
              <option value="outlook" disabled={!outlookReady}>
                {sendStatus?.outlook.mailboxEmail ? `Outlook · ${sendStatus.outlook.mailboxEmail}` : "Connected Outlook mailbox"}
              </option>
            </select>
            <p className="text-xs text-muted-foreground">
              {provider === "outlook"
                ? "Send from your connected Microsoft mailbox. Submission appears in Outlook Sent Items; delivery is not confirmed here."
                : "Use the company email sender. An owner can enable Outlook email in Settings."}
            </p>
            {sendStatus?.mode === "capture" && <p className="text-xs text-muted-foreground">Practice messages are captured without sending.</p>}
            {sendStatus?.mode === "allowlist" && <p className="text-xs text-muted-foreground">Only approved test addresses receive emails.</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${formId}-to`}>To</Label>
            <Input
              id={`${formId}-to`}
              type="email"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="customer@example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${formId}-subject`}>Subject</Label>
            <Input
              id={`${formId}-subject`}
              required
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Your flooring estimate"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${formId}-body`}>Message</Label>
            <Textarea
              id={`${formId}-body`}
              required
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              placeholder="Write your message…"
            />
          </div>
        </form>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={sending}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={sending || (provider === "outlook" && !outlookReady)}>
            {sending ? "Sending…" : "Send Email"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
