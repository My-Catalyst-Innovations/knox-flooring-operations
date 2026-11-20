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
import { MessageSquare } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { communicationStatus } from "@/lib/communication-status";
import type { Communication } from "@/lib/types";

interface SmsComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefilled recipient phone number from the lead/customer. */
  toNumber: string;
  customerName?: string;
  defaultBody?: string;
  onSend: (input: {
    to: string;
    body: string;
    customerName?: string;
    idempotencyKey: string;
  }) => Promise<Communication>;
}

const MAX_SMS = 1600;

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
  const pending = useRef(false);
  const attempt = useRef<{ fingerprint: string; key: string }>(null);
  const formId = useId();

  useEffect(() => {
    if (open) {
      setTo(toNumber);
      setBody(defaultBody);
    }
    // Reset the form to the prefilled values each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSend = async () => {
    if (pending.current) return;
    if (!to.trim()) {
      toast({ title: "Recipient number is required", variant: "destructive" });
      return;
    }
    if (!body.trim()) {
      toast({ title: "Message is required", variant: "destructive" });
      return;
    }
    pending.current = true;
    setSending(true);
    try {
      const input = { to: to.trim(), body, customerName };
      const fingerprint = JSON.stringify(input);
      if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
      const result = await onSend({ ...input, idempotencyKey: attempt.current.key });
      const failed = result.status === "failed";
      const unconfirmed = result.status === "unknown" || (result.status === "queued" && !result.providerMessageId);
      toast({ title: communicationStatus(result), description: result.errorMessage ?? undefined, ...(failed || unconfirmed ? { variant: "destructive" as const } : {}) });
      if (!unconfirmed) attempt.current = null;
      if (!failed) onOpenChange(false);
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
    <Dialog open={open} onOpenChange={(next) => { if (!pending.current) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5" /> Send Text Message
          </DialogTitle>
          <DialogDescription>
            {customerName
              ? `Send an SMS to ${customerName}.`
              : "Send a text message."}
          </DialogDescription>
        </DialogHeader>
        <form id={formId} className="space-y-4" onSubmit={(event) => { event.preventDefault(); void handleSend(); }}>
          <div className="space-y-2">
            <Label htmlFor={`${formId}-to`}>To</Label>
            <Input
              id={`${formId}-to`}
              type="tel"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="+1 865 555 0123"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${formId}-body`}>Message</Label>
            <Textarea
              id={`${formId}-body`}
              required
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, MAX_SMS))}
              rows={5}
              placeholder="Write your text…"
            />
            <p className="text-xs text-muted-foreground text-right">
              {body.length}/{MAX_SMS}
            </p>
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
          <Button type="submit" form={formId} disabled={sending}>
            {sending ? "Sending…" : "Send Text"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
