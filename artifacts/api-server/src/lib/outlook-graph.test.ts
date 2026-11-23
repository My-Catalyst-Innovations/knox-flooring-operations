import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  fetchOutlookToken,
  getOutlookConfig,
  getOutlookAuthorization,
  getOutlookVerifier,
  hasOutlookMailScope,
  openOutlookSecret,
  outlookGraph,
  reconcileOutlookInstallation,
  sealOutlookSecret,
  startOutlookAuthorization,
} from "./outlook-graph";

const environment = {
  OUTLOOK_CLIENT_ID: "mock-entra-app",
  OUTLOOK_CLIENT_SECRET: "not-a-secret",
  OUTLOOK_REDIRECT_URI:
    "https://catalyst.example.test/api/calendar/outlook/callback",
  OUTLOOK_ENCRYPTION_KEY: "mock-only-encryption-key-for-unit-tests",
};
const config = getOutlookConfig(environment)!;
const installation = {
  jobNumber: "JOB-123",
  crewName: "Crew 1",
  startAt: "2026-11-02T08:00:00-05:00",
  endAt: "2026-11-02T11:00:00-05:00",
};
const calendarId = "shared/crew-calendar";
const installationKey = "catalyst-job-1-1";

describe("Outlook calendar OAuth", () => {
  it("uses delegated scopes, PKCE and a session-bound, expiring cookie", () => {
    const start = startOutlookAuthorization(config, "owner", "csrf", 1000);
    const params = new URL(start.authorizationUrl).searchParams;
    const state = params.get("state")!;
    const verifier = getOutlookVerifier(
      config,
      start.cookie,
      state,
      "owner",
      "csrf",
      1200,
    );
    expect(verifier).toBeTruthy();
    expect(params.get("code_challenge")).toBe(
      createHash("sha256").update(verifier!).digest("base64url"),
    );
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("scope")).toBe(
      "offline_access User.Read Calendars.ReadWrite.Shared",
    );
    expect(
      getOutlookVerifier(
        config,
        start.cookie,
        `${state}x`,
        "owner",
        "csrf",
        1200,
      ),
    ).toBeNull();
    expect(
      getOutlookVerifier(
        config,
        start.cookie,
        state,
        "other-owner",
        "csrf",
        1200,
      ),
    ).toBeNull();
    expect(
      getOutlookVerifier(
        config,
        start.cookie,
        state,
        "owner",
        "different-session",
        1200,
      ),
    ).toBeNull();
    expect(
      getOutlookVerifier(
        config,
        start.cookie,
        state,
        "owner",
        "csrf",
        1000 + start.maxAge,
      ),
    ).toBeNull();
    expect(
      getOutlookVerifier(
        config,
        `${start.cookie}.tampered`,
        state,
        "owner",
        "csrf",
        1200,
      ),
    ).toBeNull();
  });

  it("enforces cookie and token purpose and supports personal calendar consent", () => {
    const value = sealOutlookSecret(
      config,
      "mock-token",
      "refresh:first-account",
    );
    expect(value).not.toContain("mock-token");
    expect(openOutlookSecret(config, value, "refresh:first-account")).toBe(
      "mock-token",
    );
    expect(() =>
      openOutlookSecret(config, value, "access:first-account"),
    ).toThrow();
    expect(() =>
      openOutlookSecret(config, value, "refresh:second-account"),
    ).toThrow();
    expect(
      getOutlookConfig({ ...environment, OUTLOOK_TENANT_ID: "consumers" })
        ?.scope,
    ).toBe("offline_access User.Read Calendars.ReadWrite");
    expect(
      getOutlookConfig({
        ...environment,
        OUTLOOK_REDIRECT_URI:
          "http://catalyst.example.test/api/calendar/outlook/callback",
      }),
    ).toBeNull();
  });

  it("binds optional mailbox consent to the owner session and the token exchange", async () => {
    const start = startOutlookAuthorization(config, "owner", "csrf", 1000, {
      mail: true,
    });
    const params = new URL(start.authorizationUrl).searchParams;
    const authorization = getOutlookAuthorization(
      config,
      start.cookie,
      params.get("state")!,
      "owner",
      "csrf",
      1200,
    )!;
    expect(authorization.scope).toBe(
      "offline_access User.Read Calendars.ReadWrite.Shared Mail.Send",
    );
    expect(params.get("scope")).toBe(authorization.scope);
    expect(
      getOutlookAuthorization(
        config,
        start.cookie,
        params.get("state")!,
        "owner",
        "other-csrf",
        1200,
      ),
    ).toBeNull();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          access_token: "opaque-token",
          refresh_token: "refresh",
          expires_in: 3600,
          scope: "User.Read Calendars.ReadWrite.Shared",
        }),
      );
    const granted = await fetchOutlookToken(
      config,
      { code: "code", ...authorization },
      fetchMock,
    );
    expect(
      (fetchMock.mock.calls[0][1]?.body as URLSearchParams).get("scope"),
    ).toBe(authorization.scope);
    // Requesting Mail.Send is not evidence Microsoft actually granted it.
    expect(hasOutlookMailScope(granted.scope)).toBe(false);
    expect(hasOutlookMailScope(undefined)).toBe(false);
    expect(
      hasOutlookMailScope("User.Read https://graph.microsoft.com/Mail.Send"),
    ).toBe(true);
    expect(hasOutlookMailScope("Mail.Send.Shared Mail.Read")).toBe(false);
  });

  it("refreshes only the previously granted scopes and retains the returned capability response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          access_token: "opaque-token",
          expires_in: 3600,
          scope: "User.Read Calendars.ReadWrite.Shared",
        }),
      );
    const response = await fetchOutlookToken(
      config,
      {
        refreshToken: "refresh",
        scope: "offline_access User.Read Calendars.ReadWrite.Shared Mail.Send",
      },
      fetchMock,
    );
    expect(
      (fetchMock.mock.calls[0][1]?.body as URLSearchParams).get("scope"),
    ).toBe("offline_access User.Read Calendars.ReadWrite.Shared Mail.Send");
    expect(hasOutlookMailScope(response.scope)).toBe(false);
  });

  it("exchanges codes with the verifier and refreshes without exposing provider details", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: "invalid_grant", error_description: "details" },
          { status: 400 },
        ),
      );
    await expect(
      fetchOutlookToken(
        config,
        { code: "code", verifier: "verifier" },
        fetchMock,
      ),
    ).resolves.toMatchObject({
      access_token: "access",
      refresh_token: "refresh",
    });
    expect(fetchMock.mock.calls[0][1]?.body).toMatchObject(
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: config.scope,
        grant_type: "authorization_code",
        code: "code",
        code_verifier: "verifier",
        redirect_uri: config.redirectUri,
      }),
    );
    await expect(
      fetchOutlookToken(config, { refreshToken: "refresh" }, fetchMock),
    ).rejects.toMatchObject({
      status: 401,
      message: expect.not.stringContaining("details"),
    });
    expect(
      (fetchMock.mock.calls[1][1]?.body as URLSearchParams).get("grant_type"),
    ).toBe("refresh_token");
  });
});

describe("Outlook mailbox submissions", () => {
  const message = {
    to: "owner@example.test",
    subject: "Internal verification",
    body: "No client data.",
  };

  it("submits plain text as the connected mailbox, saves Sent Items and reports acceptance only", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    await expect(
      outlookGraph("opaque-token", fetchMock).sendMail(message),
    ).resolves.toEqual({ accepted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(request?.method).toBe("POST");
    const payload = JSON.parse(String(request?.body));
    expect(payload).toEqual({
      message: {
        subject: message.subject,
        body: { contentType: "Text", content: message.body },
        toRecipients: [{ emailAddress: { address: message.to } }],
      },
      saveToSentItems: true,
    });
    expect(payload.message).not.toHaveProperty("from");
  });

  it.each([400, 401, 403, 404, 429])(
    "classifies Microsoft %i as a refused submission without sending again",
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status }));
      await expect(
        outlookGraph("opaque-token", fetchMock).sendMail(message),
      ).rejects.toMatchObject({ status, submissionUnknown: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([408, 500, 502, 503, 504, 200, 204])(
    "blocks automatic retry after an ambiguous Microsoft %i response",
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status }));
      await expect(
        outlookGraph("opaque-token", fetchMock).sendMail(message),
      ).rejects.toMatchObject({ status: 502, submissionUnknown: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry a network failure whose remote outcome cannot be known", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("connection lost after write"));
    await expect(
      outlookGraph("opaque-token", fetchMock).sendMail(message),
    ).rejects.toMatchObject({
      submissionUnknown: true,
      message: expect.stringContaining("Check Outlook Sent Items"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Outlook Graph appointments", () => {
  it("lists writable calendars across pages without forwarding a token to another host", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          value: [{ id: "readonly", name: "Read only", canEdit: false }],
          "@odata.nextLink":
            "https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=next",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          value: [{ id: calendarId, name: "Crew", canEdit: true }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          value: [],
          "@odata.nextLink":
            "https://wrong-host.example.test/v1.0/me/calendars",
        }),
      );
    const graph = outlookGraph("access", fetchMock);
    await expect(graph.calendars()).resolves.toEqual([
      { id: calendarId, name: "Crew", canEdit: true },
    ]);
    await expect(graph.calendars()).rejects.toThrow(
      "invalid continuation link",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer access",
      Prefer: 'IdType="ImmutableId"',
    });
  });

  it("creates a UTC event with a stable transaction id and no attendee invites", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ value: [] }))
      .mockResolvedValueOnce(
        Response.json({ id: "event-id" }, { status: 201 }),
      );
    const graph = outlookGraph("access", fetchMock);
    await expect(
      reconcileOutlookInstallation(
        graph,
        calendarId,
        installationKey,
        null,
        installation,
      ),
    ).resolves.toBe("event-id");
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain(
      "/me/calendars/shared%2Fcrew-calendar/events",
    );
    expect(init?.method).toBe("POST");
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({
      subject: "Installation JOB-123",
      transactionId: installationKey,
      singleValueExtendedProperties: [{ value: installationKey }],
      start: { dateTime: "2026-11-02T13:00:00.000", timeZone: "UTC" },
      end: { dateTime: "2026-11-02T16:00:00.000", timeZone: "UTC" },
    });
    expect(payload).not.toHaveProperty("attendees");
  });

  it("finds an already-created event after an interrupted publish, then reschedules and cancels it", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ value: [{ id: "existing-event" }] }),
      )
      .mockResolvedValueOnce(Response.json({ id: "existing-event" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const graph = outlookGraph("access", fetchMock);
    await expect(
      reconcileOutlookInstallation(
        graph,
        calendarId,
        installationKey,
        null,
        installation,
      ),
    ).resolves.toBe("existing-event");
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "singleValueExtendedProperties",
    );
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PATCH");
    await expect(
      reconcileOutlookInstallation(
        graph,
        calendarId,
        installationKey,
        "existing-event",
        null,
      ),
    ).resolves.toBeNull();
    expect(fetchMock.mock.calls[2][1]?.method).toBe("DELETE");
  });

  it("reports throttling and refuses to guess when multiple calendar events match", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({}, { status: 429, headers: { "Retry-After": "120" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ value: [{ id: "one" }, { id: "two" }] }),
      );
    const graph = outlookGraph("access", fetchMock);
    await expect(
      reconcileOutlookInstallation(
        graph,
        calendarId,
        installationKey,
        null,
        installation,
      ),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 120 });
    await expect(
      reconcileOutlookInstallation(
        graph,
        calendarId,
        installationKey,
        null,
        null,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
