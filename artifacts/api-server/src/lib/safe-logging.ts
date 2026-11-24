/** Diagnostics are deliberately separate from user-visible errors and operator
 * command results. Never serialize arbitrary request/provider/error objects. */
const codes = [
  "application_event",
  "domain_request_failed",
  "request_validation_failed",
  "qbo_authorization_failed",
  "http_request_failed",
  "qbo_sync_failed",
  "qbo_worker_failed",
  "server_listen_failed",
  "startup_failed",
  "google_calendar_failed",
  "measure_square_status_failed",
  "measure_square_pull_failed",
  "measure_square_push_failed",
  "measure_square_sync_failed",
  "outlook_calendar_failed",
  "outlook_queue_failed",
  "outlook_authorization_failed",
  "communication_provider_failed",
  "workspace_provision_failed",
  "workspace_existing_records",
  "workspace_owner_exists",
  "demo_initialization_failed",
  "platform_attention",
  "request_completed",
  "request_errored",
  "request_aborted",
] as const;
export type DiagnosticCode = (typeof codes)[number];
const diagnostics = new Set<string>(codes);
const errorTypes = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DomainError",
  "QuickBooksRequestError",
  "OutlookError",
  "MicrosoftFilesError",
  "GoogleCalendarError",
  "CommsError",
  "UnknownError",
]);
const databaseCodes = new Set([
  "23502",
  "23503",
  "23505",
  "23514",
  "23001",
  "40P01",
  "40001",
  "55P03",
  "42501",
  "53300",
  "57P03",
  "08001",
  "08003",
  "08006",
]);
const methods = new Set([
  "GET",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE",
]);
const families = new Set([
  "health",
  "healthz",
  "auth",
  "jobs",
  "photos",
  "leads",
  "products",
  "tasks",
  "inventory",
  "measurements",
  "materials",
  "crews",
  "bookings",
  "customers",
  "estimates",
  "estimate-drafts",
  "proposals",
  "salespeople",
  "invoices",
  "settings",
  "communications",
  "google-calendar",
  "calendar",
  "microsoft-files",
  "files",
  "storage",
  "integrations",
  "job-materials",
  "labor-entries",
  "material-usage",
  "reports",
  "work-guides",
  "workspace-brand",
  "demo",
  "ai",
  "customer-imports",
  "legacy-history",
  "sms-preferences",
  "company-setup",
  "platform",
  "open-po-imports",
  "supplier-imports",
  "suppliers",
]);
const exactPaths = new Set([
  "/api/quickbooks/callback",
  "/api/calendar/outlook/callback",
  "/api/files/microsoft/callback",
  "/api/microsoft-files/callback",
  "/api/communications/email/webhook",
  "/api/quickbooks/webhook",
  "/api/auth/login",
  "/api/auth/session",
  "/api/auth/logout",
  "/api/auth/password/forgot",
  "/api/auth/password/reset",
  "/api/auth/staff/accept",
  "/api/healthz",
  "/api/health",
]);
exactPaths.add("/api/microsoft/files/callback");
families.add("quickbooks");
/** Read data descriptors only: a provider object cannot run a getter or toJSON
 * while being logged. Proxies/accessors fail closed without string coercion. */
function data(value: unknown, key: string): unknown {
  try {
    if (!value || (typeof value !== "object" && typeof value !== "function"))
      return undefined;
    let current: object | null = value as object;
    for (let depth = 0; current && depth < 4; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor)
        return "value" in descriptor ? descriptor.value : undefined;
      current = Object.getPrototypeOf(current);
    }
  } catch {}
  return undefined;
}
function httpStatus(value: unknown) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}
export function requestPathClass(value: unknown): string {
  if (typeof value !== "string") return "/[unmatched]";
  let path: string;
  try {
    path = new URL(value, "https://log.invalid").pathname;
  } catch {
    return "/[unmatched]";
  }
  if (exactPaths.has(path)) return path;
  if (/^\/api\/communications\/sms\/signalwire\/status\//.test(path))
    return "/api/communications/sms/signalwire/status/:id";
  if (path === "/api/communications/sms/signalwire/inbound") return path;
  if (/^\/api\/public\/jobs\//.test(path)) return "/api/public/jobs/:token";
  if (/^\/api\/public\/quotes\//.test(path)) return "/api/public/quotes/:token";
  if (/^\/p\//.test(path)) return "/p/:token";
  if (/^\/q\//.test(path)) return "/q/:token";
  const segments = path.split("/");
  if (segments[1] === "api" && families.has(segments[2]))
    return `/api/${segments[2]}${segments.length > 3 ? "/:resource" : ""}`;
  return "/[unmatched]";
}
function knownPathClass(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (
    value === "/[unmatched]" ||
    value === "/p/:token" ||
    value === "/q/:token" ||
    value === "/api/public/jobs/:token" ||
    value === "/api/public/quotes/:token" ||
    value === "/api/communications/sms/signalwire/status/:id"
  )
    return true;
  if (
    exactPaths.has(value) ||
    value === "/api/communications/sms/signalwire/inbound"
  )
    return true;
  const match = /^\/api\/([a-z-]+)(?:\/:resource)?$/.exec(value);
  return !!match && families.has(match[1]);
}
export function safeRequestLog(value: unknown) {
  const method = data(value, "method"),
    id = data(value, "id"),
    prior = data(value, "pathClass");
  return {
    ...(typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ? { id }
      : {}),
    method:
      typeof method === "string" && methods.has(method) ? method : "OTHER",
    pathClass: knownPathClass(prior)
      ? prior
      : requestPathClass(data(value, "url") ?? data(value, "originalUrl")),
  };
}
export function safeResponseLog(value: unknown) {
  const statusCode = httpStatus(data(value, "statusCode"));
  return statusCode === undefined ? {} : { statusCode };
}
export function safeErrorLog(value: unknown) {
  const label =
      data(value, "errorType") ?? data(value, "name") ?? data(value, "type"),
    errorType =
      typeof label === "string" && errorTypes.has(label)
        ? label
        : "UnknownError";
  const statusCode =
    httpStatus(data(value, "statusCode")) ?? httpStatus(data(value, "status"));
  const rawCode =
    data(value, "databaseCode") ??
    data(value, "code") ??
    data(data(value, "cause"), "code");
  return {
    errorType,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(typeof rawCode === "string" && databaseCodes.has(rawCode)
      ? { databaseCode: rawCode }
      : {}),
  };
}
export function safeDiagnostic(code: DiagnosticCode, error?: unknown) {
  return {
    diagnostic: diagnostics.has(code) ? code : "application_event",
    ...(error === undefined ? {} : safeErrorLog(error)),
  };
}

/** Preserve known operator refusals without printing arbitrary exception text.
 * Descriptor-only matching must not invoke an error's message getter. */
export function workspaceProvisionDiagnostic(error: unknown) {
  const message = data(error, "message");
  return safeDiagnostic(
    message ===
      "This database has company records. Use the explicit adoption path for an existing workspace."
      ? "workspace_existing_records"
      : message ===
          "This workspace already has an owner or an invitation for another owner."
        ? "workspace_owner_exists"
        : "workspace_provision_failed",
    error,
  );
}
const messages: Record<string, DiagnosticCode> = {
  "QuickBooks authorization failed": "qbo_authorization_failed",
  "HTTP request failed": "http_request_failed",
  "Domain request failed": "domain_request_failed",
  "QuickBooks sync failed": "qbo_sync_failed",
  "QuickBooks worker failed": "qbo_worker_failed",
  "Error listening on port": "server_listen_failed",
  "Application initialization failed; no traffic accepted": "startup_failed",
  "Google Calendar API error": "google_calendar_failed",
  "Measure Square status probe failed": "measure_square_status_failed",
  "Measure Square pull request failed": "measure_square_pull_failed",
  "Measure Square push request failed": "measure_square_push_failed",
  "Measure Square auto-sync failed": "measure_square_sync_failed",
  "Outlook calendar operation failed": "outlook_calendar_failed",
  "Outlook booking queue could not run": "outlook_queue_failed",
  "Outlook authorization could not be saved": "outlook_authorization_failed",
  "Communication provider returned an error": "communication_provider_failed",
  "Company platform requires attention": "platform_attention",
  "request completed": "request_completed",
  "request errored": "request_errored",
  "request aborted": "request_aborted",
};
const safeMessages = new Set([
  "Server listening",
  "Background integration workers are disabled",
  "Password reset request could not be completed",
  "Measure Square auto-sync disabled via MEASURE_SQUARE_AUTO_SYNC",
  "Measure Square auto-sync scheduled",
  "Measure Square auto-sync ran",
  "Seeded jobs",
  "Seeded salespeople",
  "Seeded leads",
  "Seeded materials",
  "Seeded proposals",
  "Seeded invoices",
  "Seeded products",
  "Seeded settings",
  "Seeded tasks",
  "Registered versioned executive demo baseline",
  ...Object.keys(messages),
]);
/** Applied to both ordinary fields and child bindings, before Pino serialization. */
export function safeLogFields(value: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const diagnostic = data(value, "diagnostic");
  if (typeof diagnostic === "string" && diagnostics.has(diagnostic))
    fields.diagnostic = diagnostic;
  const error = data(value, "err") ?? data(value, "error");
  if (error !== undefined) Object.assign(fields, safeErrorLog(error));
  else if (
    data(value, "errorType") !== undefined ||
    errorTypes.has(data(value, "name") as string)
  )
    Object.assign(fields, safeErrorLog(value));
  const req = data(value, "req"),
    res = data(value, "res");
  if (req !== undefined) fields.req = safeRequestLog(req);
  if (res !== undefined) fields.res = safeResponseLog(res);
  const statusCode =
    httpStatus(data(value, "statusCode")) ?? httpStatus(data(value, "status"));
  if (statusCode !== undefined) fields.statusCode = statusCode;
  for (const key of [
    "pid",
    "reqId",
    "port",
    "count",
    "intervalMs",
    "responseTime",
    "pulled",
    "pushed",
    "errors",
  ]) {
    const item = data(value, key);
    if (
      typeof item === "number" &&
      Number.isFinite(item) &&
      item >= 0 &&
      item <= 1e9
    )
      fields[key] = item;
  }
  return fields;
}
export function safeLogArguments(
  args: unknown[],
): [Record<string, unknown>, string] {
  const rawMessage = typeof args[0] === "string" ? args[0] : args[1];
  const fields = typeof args[0] === "string" ? {} : safeLogFields(args[0]);
  if (
    typeof rawMessage === "string" &&
    Object.hasOwn(messages, rawMessage) &&
    !fields.diagnostic
  )
    fields.diagnostic = messages[rawMessage];
  return [
    fields,
    typeof rawMessage === "string" && safeMessages.has(rawMessage)
      ? rawMessage
      : "Application event",
  ];
}
