import { useSearch } from "wouter";

const messages = {
  connected:
    "Authorization returned. Verify the saved company and environment below before approving any exports.",
  invalid:
    "The QuickBooks authorization expired or could not be verified. Start a fresh connection from this page.",
  cancelled:
    "QuickBooks authorization was cancelled. No new connection was completed by that response.",
  sign_in_required:
    "Sign in with the owner account, then start a fresh QuickBooks connection.",
  owner_required:
    "Use the owner account outside role preview, then start a fresh QuickBooks connection.",
  blocked:
    "The QuickBooks connection changed or needs review. Check its saved status and any pending revocation before reconnecting.",
  failed:
    "The QuickBooks authorization result could not be confirmed. Check the saved connection below before starting another attempt.",
} as const;

export function QuickBooksOAuthNotice() {
  const outcome = new URLSearchParams(useSearch()).get("quickbooks") ?? "";
  if (!Object.hasOwn(messages, outcome)) return null;
  return (
    <p role="status" className="rounded border bg-muted/30 p-3 text-sm">
      {messages[outcome as keyof typeof messages]}
    </p>
  );
}
