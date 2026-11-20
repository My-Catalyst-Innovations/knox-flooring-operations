import type { Communication } from "@/lib/types";

export function communicationStatus(message: Pick<Communication, "providerMessageId" | "status">) {
  if (message.providerMessageId?.startsWith("demo:")) return "Captured in demo";
  switch (message.status) {
    case "queued": return "Queued";
    case "sent": return "Submitted to provider";
    case "delivered": return "Delivered";
    case "failed": return "Failed";
    case "received": return "Received";
  }
}
