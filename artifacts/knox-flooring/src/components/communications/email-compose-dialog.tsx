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
  const pending = useRef(false);
  const formId = useId();

  useEffect(() => {
    if (open) {
      setTo(toAddress);
      setSubject(defaultSubject);
      setBody(defaultBody);
    }
    // Reset the form to the prefilled values each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSend = async () => {
    if (pending.current) return;
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
      const result = await onSend({ to: to.trim(), subject: subject.trim(), body, customerName });
      toast({ title: communicationStatus(result) });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Email could not be sent",
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
          <Button type="submit" form={formId} disabled={sending}>
            {sending ? "Sending…" : "Send Email"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
