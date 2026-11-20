import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

const graphOrigin = "https://graph.microsoft.com";
const connectLifetimeMs = 10 * 60_000;
const bookingProperty =
  "String {ad430fac-a588-4ac1-bee0-c6209a433482} Name CatalystInstallation";

export interface OutlookConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authority: string;
  scope: string;
  encryptionKey: Buffer;
}

export function getOutlookConfig(env = process.env): OutlookConfig | null {
  const {
    OUTLOOK_CLIENT_ID: clientId,
    OUTLOOK_CLIENT_SECRET: clientSecret,
    OUTLOOK_REDIRECT_URI: redirectUri,
    OUTLOOK_ENCRYPTION_KEY: secret,
  } = env;
  const tenant = env.OUTLOOK_TENANT_ID || "organizations";
  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !secret ||
    secret.length < 32 ||
    !/^(organizations|consumers|[0-9a-f-]{36}|[a-z0-9.-]+\.onmicrosoft\.com)$/i.test(
      tenant,
    )
  )
    return null;
  try {
    const url = new URL(redirectUri);
    const local =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !local) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/api/calendar/outlook/callback"
    )
      return null;
  } catch {
    return null;
  }
  return {
    clientId,
    clientSecret,
    redirectUri,
    authority: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`,
    scope: `offline_access User.Read ${tenant === "consumers" ? "Calendars.ReadWrite" : "Calendars.ReadWrite.Shared"}`,
    encryptionKey: createHash("sha256")
      .update("catalyst-outlook\0")
      .update(secret)
      .digest(),
  };
}

export function sealOutlookSecret(
  config: OutlookConfig,
  value: string,
  purpose: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  cipher.setAAD(Buffer.from(purpose));
  const message = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), message]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export function openOutlookSecret(
  config: OutlookConfig,
  value: string,
  purpose: string,
) {
  const [iv, tag, data, extra] = value.split(".");
  if (!iv || !tag || !data || extra !== undefined)
    throw new Error("Invalid Outlook authorization data.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    config.encryptionKey,
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

const oauthState = z.object({
  state: z.string(),
  verifier: z.string(),
  sessionHash: z.string(),
  expiresAt: z.number(),
});
const sessionHash = (userId: string, csrfToken: string) =>
  createHash("sha256").update(`${userId}\0${csrfToken}`).digest("base64url");

export function startOutlookAuthorization(
  config: OutlookConfig,
  userId: string,
  csrfToken: string,
  now = Date.now(),
) {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const cookie = sealOutlookSecret(
    config,
    JSON.stringify({
      state,
      verifier,
      sessionHash: sessionHash(userId, csrfToken),
      expiresAt: now + connectLifetimeMs,
    }),
    "oauth-state",
  );
  const url = new URL(`${config.authority}/authorize`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    response_mode: "query",
    redirect_uri: config.redirectUri,
    scope: config.scope,
    state,
    prompt: "select_account",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return {
    authorizationUrl: url.toString(),
    cookie,
    maxAge: connectLifetimeMs,
  };
}

export function getOutlookVerifier(
  config: OutlookConfig,
  cookie: string,
  state: string,
  userId: string,
  csrfToken: string,
  now = Date.now(),
) {
  try {
    const saved = oauthState.parse(
      JSON.parse(openOutlookSecret(config, cookie, "oauth-state")),
    );
    if (
      saved.expiresAt <= now ||
      saved.sessionHash !== sessionHash(userId, csrfToken)
    )
      return null;
    const expected = Buffer.from(saved.state);
    const received = Buffer.from(state);
    return expected.length === received.length &&
      timingSafeEqual(expected, received)
      ? saved.verifier
      : null;
  } catch {
    return null;
  }
}

export class OutlookError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly retryAfterSeconds = 60,
  ) {
    super(message);
  }
}

const tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().finite().positive(),
});

export async function fetchOutlookToken(
  config: OutlookConfig,
  request: { code: string; verifier: string } | { refreshToken: string },
  fetchImpl = fetch,
) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: config.scope,
  });
  if ("code" in request) {
    body.set("grant_type", "authorization_code");
    body.set("code", request.code);
    body.set("code_verifier", request.verifier);
    body.set("redirect_uri", config.redirectUri);
  } else {
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", request.refreshToken);
  }
  const response = await fetchImpl(`${config.authority}/token`, {
    method: "POST",
    body,
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  }).catch(() => {
    throw new OutlookError("Microsoft authorization could not be reached.");
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (error?.error === "invalid_grant")
      throw new OutlookError(
        "Microsoft authorization expired. Reconnect Outlook in Settings.",
        401,
      );
    throw new OutlookError(
      "Microsoft authorization could not be completed. Check the Outlook configuration and try again.",
    );
  }
  const result = tokens.safeParse(await response.json().catch(() => null));
  if (!result.success)
    throw new OutlookError(
      "Microsoft returned an incomplete authorization response.",
    );
  return result.data;
}

const graphPerson = z.object({
  id: z.string().min(1),
  displayName: z.string().nullish(),
  userPrincipalName: z.string().nullish(),
});
const graphCalendar = z.object({
  id: z.string().min(1),
  name: z.string(),
  canEdit: z.boolean().optional(),
  owner: z
    .object({ name: z.string().optional(), address: z.string().optional() })
    .nullish(),
});
const graphEvent = z.object({ id: z.string().min(1) });

function collection<T extends z.ZodType>(model: T) {
  return z.object({
    value: z.array(model),
    "@odata.nextLink": z.string().optional(),
  });
}

function graphUrl(resource: string) {
  const url = new URL(
    resource.startsWith("/") ? `/v1.0${resource}` : resource,
    graphOrigin,
  );
  if (
    url.origin !== graphOrigin ||
    !url.pathname.startsWith("/v1.0/") ||
    url.username ||
    url.password
  )
    throw new OutlookError("Microsoft returned an invalid continuation link.");
  return url;
}

export function outlookGraph(accessToken: string, fetchImpl = fetch) {
  async function request(resource: string, options: RequestInit = {}) {
    const url = graphUrl(resource);
    const response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        Prefer: 'IdType="ImmutableId"',
      },
    }).catch(() => {
      throw new OutlookError("Outlook Calendar could not be reached.");
    });
    if (response.ok) return response;
    if (response.status === 401)
      throw new OutlookError(
        "Microsoft authorization expired. Reconnect Outlook in Settings.",
        401,
      );
    if (response.status === 403)
      throw new OutlookError(
        "Microsoft denied write access to this calendar.",
        403,
      );
    if (response.status === 404)
      throw new OutlookError(
        "The Outlook calendar or event could not be found.",
        404,
      );
    if (response.status === 429) {
      const retry = Number(response.headers.get("Retry-After"));
      throw new OutlookError(
        "Outlook is limiting requests. Catalyst will retry.",
        429,
        Number.isFinite(retry) && retry > 0 ? retry : 60,
      );
    }
    throw new OutlookError(
      "Microsoft could not complete the calendar request.",
    );
  }

  async function read<T extends z.ZodType>(
    resource: string,
    model: T,
    options?: RequestInit,
  ): Promise<z.output<T>> {
    const response = await request(resource, options);
    const result = model.safeParse(await response.json().catch(() => null));
    if (!result.success)
      throw new OutlookError("Microsoft returned incomplete calendar data.");
    return result.data;
  }

  async function list<T extends z.ZodType>(resource: string, model: T) {
    const entries: z.output<T>[] = [];
    let next: string | undefined = resource;
    for (let page = 0; next && page < 30; page++) {
      const data: { value: z.output<T>[]; "@odata.nextLink"?: string } =
        await read(next, collection(model));
      entries.push(...data.value);
      next = data["@odata.nextLink"];
    }
    if (next)
      throw new OutlookError(
        "Microsoft returned too many calendar results to verify safely.",
      );
    return entries;
  }

  const calendarPath = (calendarId: string) =>
    `/me/calendars/${encodeURIComponent(calendarId)}`;
  const eventPath = (calendarId: string, eventId: string) =>
    `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`;
  return {
    account: () =>
      read("/me?$select=id,displayName,userPrincipalName", graphPerson),
    calendars: async () =>
      (
        await list("/me/calendars?$select=id,name,owner,canEdit", graphCalendar)
      ).filter((calendar) => calendar.canEdit === true),
    calendar: (calendarId: string) =>
      read(
        `${calendarPath(calendarId)}?$select=id,name,owner,canEdit`,
        graphCalendar,
      ),
    async findInstallation(calendarId: string, key: string) {
      const query = new URLSearchParams({
        $select: "id",
        $filter: `singleValueExtendedProperties/any(ep: ep/id eq '${bookingProperty}' and ep/value eq '${key.replaceAll("'", "''")}')`,
      });
      const events = await list(
        `${calendarPath(calendarId)}/events?${query}`,
        graphEvent,
      );
      if (events.length > 1)
        throw new OutlookError(
          "Multiple Outlook events match this booking. Review the calendar before retrying.",
          409,
        );
      return events[0]?.id ?? null;
    },
    async createInstallation(
      calendarId: string,
      key: string,
      event: InstallationEvent,
    ) {
      const result = await read(
        `${calendarPath(calendarId)}/events`,
        graphEvent,
        {
          method: "POST",
          body: JSON.stringify({
            ...installationPayload(event),
            transactionId: key,
            singleValueExtendedProperties: [
              { id: bookingProperty, value: key },
            ],
          }),
        },
      );
      return result.id;
    },
    async updateInstallation(
      calendarId: string,
      eventId: string,
      event: InstallationEvent,
    ) {
      await request(eventPath(calendarId, eventId), {
        method: "PATCH",
        body: JSON.stringify(installationPayload(event)),
      });
    },
    async deleteInstallation(calendarId: string, eventId: string) {
      try {
        await request(eventPath(calendarId, eventId), { method: "DELETE" });
      } catch (error) {
        if (!(error instanceof OutlookError) || error.status !== 404)
          throw error;
      }
    },
  };
}

export interface InstallationEvent {
  jobNumber: string;
  crewName: string;
  startAt: string;
  endAt: string;
}

export async function reconcileOutlookInstallation(
  graph: ReturnType<typeof outlookGraph>,
  calendarId: string,
  key: string,
  eventId: string | null,
  event: InstallationEvent | null,
) {
  const existing = eventId ?? (await graph.findInstallation(calendarId, key));
  if (!event) {
    if (existing) await graph.deleteInstallation(calendarId, existing);
    return null;
  }
  if (!existing) return graph.createInstallation(calendarId, key, event);
  await graph.updateInstallation(calendarId, existing, event);
  return existing;
}

function installationPayload(event: InstallationEvent) {
  const dateTime = (value: string) => ({
    dateTime: new Date(value).toISOString().slice(0, -1),
    timeZone: "UTC",
  });
  return {
    subject: `Installation ${event.jobNumber}`,
    body: {
      contentType: "text",
      content: `Crew: ${event.crewName}\nManage this booking in Catalyst Works.`,
    },
    start: dateTime(event.startAt),
    end: dateTime(event.endAt),
    showAs: "busy",
    isReminderOn: false,
  };
}
