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
import { Copy, MessageSquare, Share2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { communicationStatus } from "@/lib/communication-status";
import { useOperation } from "@/lib/operations";
import type { Communication } from "@/lib/types";

interface SmsComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefilled recipient phone number from the lead/customer. */
  toNumber: string;
  customerName?: string;
  defaultBody?: string;
  onSend?: (input: {
    to: string;
    body: string;
    customerName?: string;
    idempotencyKey: string;
  }) => Promise<Communication>;
}

const MAX_SMS = 1600;
const serverRoles = ["owner", "sales"];
const noRoles: string[] = [];

interface SmsProviderStatus {
  serverSendAvailable: boolean;
  mode: "capture" | "allowlist" | "live";
}

function smsRecipient(value: string) {
  const number = value.trim().replace(/[().\s-]/g, "");
  if (/^\d{10}$/.test(number)) return `+1${number}`;
  if (/^1\d{10}$/.test(number)) return `+${number}`;
  return /^\+[1-9]\d{7,14}$/.test(number) ? number : null;
}

export function SmsComposeDialog({
  open,
  onOpenChange,
  toNumber,
  customerName,
  defaultBody = "",
  onSend,
}: SmsComposeDialogProps) {
  const { toast } = useToast();
  const [to, setTo] = useState(toNumber);
  const [body, setBody] = useState(defaultBody);
  const [sending, setSending] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const attempt = useRef<{ fingerprint: string; key: string }>(null);
  const fieldId = useId();
  const { data: provider } = useOperation<SmsProviderStatus>(
    "/communications/sms/status",
    open && onSend ? serverRoles : noRoles,
  );
  const companyTestOnly = provider?.mode === "allowlist";
  const canSendFromCompany = Boolean(onSend && provider?.serverSendAvailable && (provider.mode === "live" || companyTestOnly));
  const recipient = smsRecipient(to);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const hasMessage = Boolean(body.trim());

  useEffect(() => {
    if (open) {
      setTo(toNumber);
      setBody(defaultBody);
      setNotice("");
    }
    // Reset the form to the prefilled values each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const shareMessage = async () => {
    if (sharing || !hasMessage) return;
    setNotice("");
    setSharing(true);
    try {
      await navigator.share({ text: body });
      setNotice("Finish in the app you chose. Check the recipient there before sending.");
    } catch (error) {
      const cancelled = typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
      if (!cancelled) {
        setNotice("Sharing is unavailable. Copy the message and paste it into your messaging app.");
      }
    } finally {
      setSharing(false);
    }
  };

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setNotice("Message copied. Paste it into your messaging app when you’re ready.");
    } catch {
      messageInput.current?.focus();
      messageInput.current?.select();
      setNotice("Automatic copying is unavailable. Copy the selected text and paste it into your messaging app.");
    }
  };

  const handleSend = async () => {
    if (!onSend || !canSendFromCompany || pending.current || !recipient || !hasMessage) return;
    pending.current = true;
    setSending(true);
    try {
      const input = { to: recipient, body, customerName };
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
        title: "Text submission not confirmed",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      pending.current = false;
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending.current && !sharing) onOpenChange(next); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5" /> Compose text
          </DialogTitle>
          <DialogDescription>
            {customerName
              ? `Prepare a message for ${customerName}, then finish sending on your device.`
              : "Prepare a message, then finish sending on your device."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-to`}>To</Label>
            <Input
              id={`${fieldId}-to`}
              type="tel"
              autoComplete="off"
              disabled={sending || sharing}
              value={to}
              onChange={(e) => { setTo(e.target.value); setNotice(""); }}
              placeholder="+1 865 555 0123"
            />
            {to.trim() && !recipient && <p className="text-xs text-muted-foreground">Enter a ten-digit US number or a number with its country code.</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-body`}>Message</Label>
            <Textarea
              ref={messageInput}
              id={`${fieldId}-body`}
              disabled={sending || sharing}
              value={body}
              onChange={(e) => { setBody(e.target.value.slice(0, MAX_SMS)); setNotice(""); }}
              rows={5}
              placeholder="Write your text…"
            />
            <p className="text-xs text-muted-foreground text-right">
              {body.length}/{MAX_SMS}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canShare && <Button type="button" onClick={shareMessage} disabled={!hasMessage || sending || sharing}>
              <Share2 className="mr-2 h-4 w-4" /> {sharing ? "Sharing…" : "Share from device"}
            </Button>}
            {recipient && !sending && !sharing && <Button variant={canShare ? "outline" : "default"} asChild>
              <a href={`sms:${recipient}`} onClick={() => setNotice("Finish in your messaging app. You can copy the message here to paste it there.")}>
                <MessageSquare className="mr-2 h-4 w-4" /> Open Messages
              </a>
            </Button>}
            <Button type="button" variant="outline" onClick={copyMessage} disabled={!hasMessage || sending || sharing}>
              <Copy className="mr-2 h-4 w-4" /> Copy message
            </Button>
          </div>
          {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        </div>
        <DialogFooter className="gap-2 sm:items-center">
          {canSendFromCompany && <div className="flex flex-1 flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" onClick={handleSend} disabled={!recipient || !hasMessage || sending || sharing}>
              {sending ? "Submitting…" : companyTestOnly ? "Submit company test" : "Send from company number"}
            </Button>
            {companyTestOnly && <p className="text-xs text-muted-foreground">Only approved test numbers receive texts.</p>}
          </div>}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={sending || sharing}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
