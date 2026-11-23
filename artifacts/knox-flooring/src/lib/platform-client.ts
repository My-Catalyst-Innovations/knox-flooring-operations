export class PlatformRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export interface PlatformReadiness {
  enabled: boolean;
  signupAvailable: boolean;
  blockers: string[];
  tenantDomain?: string;
  termsUrl?: string;
  privacyUrl?: string;
  trialDays?: number;
  plans: {
    key: string;
    name: string;
    interval: "month" | "year";
    currency: string;
    unitAmount: number;
    displayAmount?: string;
  }[];
}
export async function platformRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  csrf?: string,
): Promise<T> {
  const response = await fetch(`/api/platform${path}`, {
    method,
    credentials: "include",
    cache: "no-store",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(csrf ? { "x-platform-csrf": csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new PlatformRequestError(
      response.status >= 500
        ? "Company accounts are temporarily unavailable. Please try again later."
        : typeof value.error === "string"
          ? value.error
          : "This account action is unavailable. Try again shortly.",
      response.status,
    );
  return value as T;
}
export function httpsLink(value?: string | null) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function billingDestination(value: string, kind: "checkout" | "portal") {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname !==
      (kind === "checkout" ? "checkout.stripe.com" : "billing.stripe.com")
  )
    throw new Error("The billing provider returned an invalid address.");
  return url.href;
}
