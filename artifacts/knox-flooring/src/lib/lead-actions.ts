import type { Lead } from "./types";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

type UpdateLead = (id: string, updates: Partial<Lead>) => Promise<void>;

export async function markLeadLost(
  lead: Lead,
  reason: string,
  deps: { updateLead: UpdateLead },
): Promise<void> {
  const finalReason = reason.trim() || "Not specified";
  const activity = {
    id: crypto.randomUUID(),
    date: todayISO(),
    type: "Stage Change" as const,
    note: `Lead marked Lost. Reason: ${finalReason}.`,
  };

  await deps.updateLead(lead.id, {
    stage: "Lost",
    lostReason: finalReason,
    activityLog: [...lead.activityLog, activity],
  });
}
