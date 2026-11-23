import type { Communication } from "@/lib/types";

export function communicationStatus(
  message: Pick<Communication, "providerMessageId" | "status" | "emailProvider">,
) {
  if (message.providerMessageId?.startsWith("demo:")) return "Captured in demo";
  switch (message.status) {
    case "captured":
      return "Captured in demo";
    case "queued":
      return message.providerMessageId
        ? "Queued by provider"
        : "Submission pending";
    case "sent":
      return message.emailProvider === "outlook" ? "Submitted to Outlook" : "Submitted to provider";
    case "delivered":
      return "Delivered";
    case "failed":
      return "Failed";
    case "unknown":
      return "Submission unconfirmed";
    case "received":
      return "Received";
  }
}
