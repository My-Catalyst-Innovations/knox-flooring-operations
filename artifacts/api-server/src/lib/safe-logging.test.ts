import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSafeLogger, safeLoggerOptions } from "./logger";
import {
  requestPathClass,
  safeDiagnostic,
  safeErrorLog,
  safeLogFields,
  safeRequestLog,
  safeResponseLog,
  workspaceProvisionDiagnostic,
} from "./safe-logging";

afterEach(() => vi.unstubAllEnvs());

function capture() {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return {
    logger: createSafeLogger(destination),
    text: () => chunks.join(""),
    rows: () =>
      chunks.flatMap((chunk) =>
        chunk
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ),
  };
}

describe("safe structured diagnostics", () => {
  it("preserves the exact existing-owner refusal without accepting partial or credential-bearing messages", () => {
    const known =
      "This workspace already has an owner or an invitation for another owner.";
    expect(workspaceProvisionDiagnostic(new Error(known))).toEqual({
      diagnostic: "workspace_owner_exists",
      errorType: "Error",
    });
    for (const message of [
      known + " OWNER_SECRET",
      "OWNER_SECRET already has an owner",
      "already has an owner",
    ]) {
      expect(workspaceProvisionDiagnostic(new Error(message))).toEqual({
        diagnostic: "workspace_provision_failed",
        errorType: "Error",
      });
    }
  });
  it("identifies only the exact known existing-record refusal with a fixed code", () => {
    const known =
      "This database has company records. Use the explicit adoption path for an existing workspace.";
    expect(workspaceProvisionDiagnostic(new Error(known))).toEqual({
      diagnostic: "workspace_existing_records",
      errorType: "Error",
    });
    for (const message of [
      known + " TOKEN_SECRET",
      "database has company records TOKEN_SECRET",
      "postgresql://USER_SECRET:PASSWORD_SECRET@private.invalid/db",
      "Unexpected PROVIDER_SECRET",
    ]) {
      const result = workspaceProvisionDiagnostic(new Error(message));
      expect(result).toEqual({
        diagnostic: "workspace_provision_failed",
        errorType: "Error",
      });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
  });

  it("never invokes a provisioning error message getter or serializer", () => {
    const getter = vi.fn(() => {
      throw new Error("GETTER_SECRET");
    });
    const error = Object.defineProperty(
      { name: "Error", toJSON: getter },
      "message",
      { get: getter },
    );
    expect(workspaceProvisionDiagnostic(error)).toEqual({
      diagnostic: "workspace_provision_failed",
      errorType: "Error",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    [
      "/api/quickbooks/callback?code=QUERY_SECRET&state=STATE_SECRET&realmId=REALM_SECRET",
      "/api/quickbooks/callback",
    ],
    [
      "/api/microsoft/files/callback?code=FILES_SECRET",
      "/api/microsoft/files/callback",
    ],
    [
      "/api/calendar/outlook/callback?state=STATE_SECRET",
      "/api/calendar/outlook/callback",
    ],
    ["/api/jobs/JOB_SECRET?access_token=TOKEN_SECRET", "/api/jobs/:resource"],
    [
      "/api/communications/sms/signalwire/status/CALLBACK_SECRET",
      "/api/communications/sms/signalwire/status/:id",
    ],
    ["/api/public/jobs/PUBLIC_SECRET", "/api/public/jobs/:token"],
    ["/q/QUOTE_SECRET", "/q/:token"],
    ["/UNRECOGNIZED_SECRET?password=PASSWORD_SECRET", "/[unmatched]"],
    ["/api/quickbooks%2fSECRET/callback", "/[unmatched]"],
  ])("records only a fixed path class for %s", (url, expected) => {
    expect(requestPathClass(url)).toBe(expected);
  });

  it("does not run arbitrary getters, coercion, or serialization hooks", () => {
    const trap = vi.fn(() => {
      throw new Error("GETTER_SECRET");
    });
    const hostile = { toJSON: trap, toString: trap };
    Object.defineProperties(hostile, {
      req: { get: trap },
      name: { get: trap },
      message: { get: trap },
      error: { get: trap },
      statusCode: { get: trap },
    });
    expect(safeLogFields(hostile)).toEqual({});
    expect(safeErrorLog(hostile)).toEqual({ errorType: "UnknownError" });
    expect(safeRequestLog(hostile)).toEqual({
      method: "OTHER",
      pathClass: "/[unmatched]",
    });
    expect(safeResponseLog(hostile)).toEqual({});
    expect(trap).not.toHaveBeenCalled();
  });

  it("keeps safe class/status/SQLSTATE and is idempotent under child serialization", () => {
    const error = Object.assign(new TypeError("TOKEN_SECRET"), {
      status: 503,
      cause: { code: "23505", message: "SQL_SECRET" },
    });
    expect(safeErrorLog(error)).toEqual({
      errorType: "TypeError",
      statusCode: 503,
      databaseCode: "23505",
    });
    expect(safeErrorLog(safeErrorLog(error))).toEqual(safeErrorLog(error));
    const request = {
      id: 42,
      method: "GET",
      url: "/api/quickbooks/callback?code=CODE_SECRET",
      headers: { cookie: "COOKIE_SECRET" },
    };
    expect(safeRequestLog(safeRequestLog(request))).toEqual(
      safeRequestLog(request),
    );
    expect(
      safeErrorLog({
        name: "PROVIDER_SECRET",
        code: "TOKEN_SECRET",
        status: 999,
      }),
    ).toEqual({ errorType: "UnknownError" });
  });

  it("removes request/provider secrets from actual Pino output including child bindings", () => {
    const output = capture();
    const error = Object.assign(new Error("ERROR_SECRET"), {
      status: 502,
      stack: "STACK_SECRET",
      cause: { code: "23503", token: "CAUSE_SECRET" },
      response: { body: "PROVIDER_SECRET" },
    });
    const child = output.logger.child({
      req: {
        id: 17,
        method: "GET",
        url: "/api/quickbooks/callback?code=CODE_SECRET&state=STATE_SECRET&realmId=REALM_SECRET&access_token=ACCESS_SECRET&refresh_token=REFRESH_SECRET&client_secret=CLIENT_SECRET",
        headers: {
          cookie: "COOKIE_SECRET",
          authorization: "AUTH_SECRET",
          referer: "REFERER_SECRET",
        },
      },
      credentials: { password: "PASSWORD_SECRET" },
      hostname: "HOST_SECRET",
      realmId: "REALM_SECRET",
      toJSON: () => ({ leaked: "SERIALIZER_SECRET" }),
    });
    child.error(
      {
        err: error,
        provider: { token: "NESTED_SECRET" },
        res: { statusCode: 502, headers: { "set-cookie": "SETCOOKIE_SECRET" } },
      },
      "QuickBooks sync failed",
    );
    child.error(error);
    child.warn("Interpolated %s", "MESSAGE_SECRET");
    child.info(
      { errors: "VALIDATION_SECRET", payload: "PAYLOAD_SECRET" },
      "UNTRUSTED_SECRET",
    );
    output.logger.error(
      safeDiagnostic("qbo_authorization_failed", error),
      "QuickBooks authorization failed",
    );
    const text = output.text();
    expect(text).not.toContain("SECRET");
    expect(text).not.toMatch(
      /"(?:url|headers|body|message|stack|hostname|realmId|credentials|payload)"/,
    );
    const rows = output.rows();
    expect(rows[0]).toMatchObject({
      diagnostic: "qbo_sync_failed",
      errorType: "Error",
      statusCode: 502,
      databaseCode: "23503",
      req: { id: 17, method: "GET", pathClass: "/api/quickbooks/callback" },
      res: { statusCode: 502 },
    });
    expect(rows[1]).toMatchObject({
      errorType: "Error",
      msg: "Application event",
    });
    expect(rows[2].msg).toBe("Application event");
    expect(rows.at(-1)).toMatchObject({
      diagnostic: "qbo_authorization_failed",
      msg: "QuickBooks authorization failed",
    });
  });

  it("does not leak hostile errors or unsafe runtime diagnostic codes", () => {
    const output = capture();
    const toJSON = vi.fn(() => {
      throw new Error("SERIALIZER_SECRET");
    });
    output.logger.error(
      {
        error: {
          name: "TypeError",
          status: 403,
          message: "MESSAGE_SECRET",
          toJSON,
        },
        token: "TOKEN_SECRET",
      },
      "Domain request failed",
    );
    output.logger.info(safeDiagnostic("ARBITRARY_SECRET" as never));
    expect(output.text()).not.toContain("SECRET");
    expect(toJSON).not.toHaveBeenCalled();
    expect(output.rows()[1].diagnostic).toBe("application_event");
  });

  it("sanitizes nested child and later bindings before serialization", () => {
    const output = capture();
    const toJSON = vi.fn(() => ({ secret: "SERIALIZER_SECRET" }));
    const child = output.logger.child({ token: { toJSON } }).child({
      req: {
        method: "POST",
        url: "/api/jobs/ID_SECRET",
        headers: { authorization: "AUTH_SECRET" },
      },
    });
    child.setBindings({
      password: "PASSWORD_SECRET",
      secretObject: { toJSON },
      count: 2,
    });
    child.info({ status: 202 }, "request completed");
    expect(output.text()).not.toContain("SECRET");
    expect(toJSON).not.toHaveBeenCalled();
    expect(output.rows()[0]).toMatchObject({
      count: 2,
      statusCode: 202,
      req: { method: "POST", pathClass: "/api/jobs/:resource" },
    });
  });

  it("does not allow child prefixes or serializer overrides to add credentials", () => {
    const output = capture();
    const serializer = vi.fn(() => ({ secret: "OVERRIDE_SECRET" }));
    output.logger
      .child(
        {},
        {
          msgPrefix: "PREFIX_SECRET",
          serializers: { req: serializer },
          formatters: { bindings: serializer, log: serializer },
        },
      )
      .error(
        {
          req: {
            method: "GET",
            url: "/api/quickbooks/callback?code=CODE_SECRET",
          },
        },
        "Domain request failed",
      );
    expect(output.text()).not.toContain("SECRET");
    expect(serializer).not.toHaveBeenCalled();
    expect(output.rows()[0]).toMatchObject({
      diagnostic: "domain_request_failed",
      req: { method: "GET", pathClass: "/api/quickbooks/callback" },
    });
  });

  it("uses a safe default for invalid configured log levels", () => {
    vi.stubEnv("LOG_LEVEL", "INVALID_SECRET");
    expect(safeLoggerOptions().level).toBe("info");
    expect(capture().text()).toBe("");
  });
});
