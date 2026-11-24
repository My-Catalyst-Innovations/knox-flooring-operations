import { expect, it } from "vitest";
import {
  quickBooksAuthorizationDestination,
  quickBooksOAuthAvailable,
  verifiedQuickBooksEntryStatus,
} from "./quickbooks-entry";
const stopped = {
  configured: true,
  connection: {
    connected: false,
    localUseStopped: true,
    revocationRetryAvailable: true,
    status: "disconnected" as const,
    companyName: "Saved company",
    environment: "sandbox" as const,
    revocation: "unknown" as const,
  },
};
it("allows only the exact HTTPS Intuit authorization destination", () => {
  const allowed =
    "https://appcenter.intuit.com/connect/oauth2?client_id=example&state=opaque";
  expect(quickBooksAuthorizationDestination(allowed)).toBe(allowed);
  for (const value of [
    "javascript:alert(1)",
    "http://appcenter.intuit.com/connect/oauth2",
    "https://appcenter.intuit.com.evil.invalid/connect/oauth2",
    "https://attacker@appcenter.intuit.com/connect/oauth2",
    "https://appcenter.intuit.com:8443/connect/oauth2",
    "//appcenter.intuit.com/connect/oauth2",
    "https://appcenter.intuit.com/elsewhere",
    "https://appcenter.intuit.com/connect/oauth2#unexpected",
    null,
  ])
    expect(quickBooksAuthorizationDestination(value)).toBeNull();
});
it("keeps pending, unknown and failed revocations from starting a new grant", () => {
  for (const revocation of ["pending", "unknown", "failed"] as const)
    expect(
      quickBooksOAuthAvailable({
        ...stopped,
        connection: { ...stopped.connection, revocation },
      }),
    ).toBe(false);
  expect(
    quickBooksOAuthAvailable({
      ...stopped,
      connection: { ...stopped.connection, revocation: "confirmed" },
    }),
  ).toBe(true);
  expect(quickBooksOAuthAvailable({ ...stopped, configured: false })).toBe(
    false,
  );
  expect(
    quickBooksOAuthAvailable({
      ...stopped,
      connection: { ...stopped.connection, revocation: "not_requested" },
    }),
  ).toBe(false);
});
it("rejects malformed or inconsistent saved status rather than inventing a successful connection", () => {
  expect(verifiedQuickBooksEntryStatus(stopped)).toEqual(stopped);
  for (const value of [
    {},
    { ...stopped, connection: { ...stopped.connection, connected: true } },
    {
      ...stopped,
      connection: { ...stopped.connection, revocation: "provider_approved" },
    },
    {
      ...stopped,
      connection: {
        ...stopped.connection,
        localUseStopped: false,
        revocationRetryAvailable: false,
        revocation: "confirmed",
      },
    },
  ])
    expect(verifiedQuickBooksEntryStatus(value)).toBeNull();
});
