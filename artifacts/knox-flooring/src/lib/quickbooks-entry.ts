export type QuickBooksRevocation =
  | "not_requested"
  | "pending"
  | "unknown"
  | "failed"
  | "confirmed"
  | "not_connected";
export interface QuickBooksEntryStatus {
  configured: boolean;
  connection: {
    connected: boolean;
    localUseStopped: boolean;
    revocationRetryAvailable: boolean;
    status:
      | "not_connected"
      | "not_configured"
      | "connected"
      | "reconnect_required"
      | "disconnected"
      | "error";
    companyName: string | null;
    environment: "sandbox" | "production" | null;
    revocation: QuickBooksRevocation;
  };
}
const states = new Set([
  "not_connected",
  "not_configured",
  "connected",
  "reconnect_required",
  "disconnected",
  "error",
]);
const revocations = new Set([
  "not_requested",
  "pending",
  "unknown",
  "failed",
  "confirmed",
  "not_connected",
]);
export function verifiedQuickBooksEntryStatus(
  value: unknown,
): QuickBooksEntryStatus | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as QuickBooksEntryStatus,
    connection = candidate.connection;
  if (
    typeof candidate.configured !== "boolean" ||
    !connection ||
    typeof connection.connected !== "boolean" ||
    typeof connection.localUseStopped !== "boolean" ||
    typeof connection.revocationRetryAvailable !== "boolean" ||
    !states.has(connection.status) ||
    !revocations.has(connection.revocation) ||
    ![null, "sandbox", "production"].includes(connection.environment) ||
    !(
      connection.companyName === null ||
      typeof connection.companyName === "string"
    )
  )
    return null;
  if (
    connection.connected !== (connection.status === "connected") ||
    (connection.connected && connection.localUseStopped) ||
    (connection.revocation === "confirmed" && !connection.localUseStopped)
  )
    return null;
  return candidate;
}
export function quickBooksAuthorizationDestination(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === "https://appcenter.intuit.com" &&
      url.pathname === "/connect/oauth2" &&
      !url.username &&
      !url.password &&
      !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export const quickBooksRevocationUnresolved = (
  status: QuickBooksEntryStatus,
) =>
  status.connection.localUseStopped
    ? status.connection.revocation !== "confirmed"
    : ["pending", "unknown", "failed"].includes(status.connection.revocation);
export const quickBooksOAuthAvailable = (status: QuickBooksEntryStatus) =>
  status.configured &&
  status.connection.status !== "error" &&
  !quickBooksRevocationUnresolved(status) &&
  (!status.connection.localUseStopped ||
    status.connection.revocation === "confirmed");
