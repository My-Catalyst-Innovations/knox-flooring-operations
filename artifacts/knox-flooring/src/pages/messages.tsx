import { useState } from "react";
import { Link } from "wouter";
import { useCommunications } from "@/hooks/use-store";
import { useOperation } from "@/lib/operations";
import type { Communication } from "@/lib/types";
import { DataBoundary } from "@/components/layout/DataBoundary";
import { CommunicationsHistory, SmsComposeDialog } from "@/components/communications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Messages() {
  const query = useOperation<Communication[]>("/communications", ["owner", "sales"]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Communication | null>(null);
  const [composing, setComposing] = useState(false);
  const reply = useCommunications(selected?.leadId ? { leadId: selected.leadId }
    : selected?.customerKey ? { customerKey: selected.customerKey } : {});
  const messages = (query.data ?? []).filter((message) => {
    const matches = [message.customerName, message.fromAddress, message.toAddress, message.subject, message.body]
      .join(" ").toLowerCase().includes(search.toLowerCase());
    if (!matches) return false;
    if (filter === "incoming") return message.direction === "inbound";
    if (filter === "unassigned") return message.direction === "inbound" && !message.leadId && !message.customerKey;
    if (filter === "attention") return message.status === "failed" || message.status === "unknown";
    return true;
  });
  const recipient = selected?.direction === "inbound" ? selected.fromAddress : selected?.toAddress;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Messages</h1>
        <Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>Refresh</Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <Input className="max-w-md" aria-label="Search messages" placeholder="Search name, number, or message" value={search} onChange={(event) => setSearch(event.target.value)} />
        <select className="h-10 rounded-md border bg-background px-3 text-sm" aria-label="Message filter" value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">All messages</option><option value="incoming">Incoming</option>
          <option value="unassigned">Unassigned incoming</option><option value="attention">Needs attention</option>
        </select>
      </div>
      <DataBoundary query={query} name="messages">
        {!messages.length && <p className="text-sm text-muted-foreground">No messages match this view.</p>}
        <ul className="space-y-5">
          {messages.map((message) => (
            <li key={message.id} className="space-y-2">
              <CommunicationsHistory communications={[message]} />
              <div className="flex flex-wrap items-center gap-3 text-sm">
                {message.customerName && <span>{message.customerName}</span>}
                {message.leadId && <Link href={`/leads/${encodeURIComponent(message.leadId)}`} className="text-primary hover:underline">Open lead</Link>}
                {message.direction === "inbound" && !message.leadId && !message.customerKey && <span className="text-muted-foreground">Unassigned sender</span>}
                {message.channel === "sms" && <Button variant="outline" size="sm" onClick={() => { setSelected(message); setComposing(true); }}>Compose text</Button>}
              </div>
            </li>
          ))}
        </ul>
      </DataBoundary>
      <SmsComposeDialog open={composing} onOpenChange={setComposing} toNumber={recipient ?? ""} customerName={selected?.customerName} onSend={async (input) => {
        const result = await reply.sendSms(input);
        await query.refetch();
        return result;
      }} />
    </div>
  );
}
