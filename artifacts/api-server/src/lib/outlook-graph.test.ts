import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  fetchOutlookToken,
  getOutlookConfig,
  getOutlookVerifier,
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
