import express, { type Request, type Response } from "express";
import request from "supertest";
import pinoHttp from "pino-http";
import { afterEach, expect, it, vi } from "vitest";
import { createSafeLogger } from "../lib/logger";
import {
  safeRequestLog,
  safeResponseLog,
  safeErrorLog,
} from "../lib/safe-logging";
import { apiSecurity } from "./api-security";
import { safeFinalErrorHandler } from "./safe-error-handler";

const secret = "SENTINEL-RAW-ERROR-CREDENTIAL";
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const logs: string[] = [];
  const logger = createSafeLogger({
    write: (value) => {
      logs.push(value);
    },
  });
  const app = express();
  // Production finalhandler would print raw Error.stack; no implicit test-mode suppression.
  app.set("env", "production");
  app.use(
    apiSecurity,
    pinoHttp({
      logger,
      wrapSerializers: false,
      serializers: {
        req: safeRequestLog,
        res: safeResponseLog,
        err: safeErrorLog,
      },
    }),
  );
  app.use(express.json({ limit: "120b" }));
  app.post("/api/parse", (_req, res) => res.json({ accepted: true }));
  app.get("/api/provider", (_req, _res, next) => {
    const error = new Error(
      `${secret} https://provider.invalid?access_token=${secret}`,
    );
    Object.assign(error, {
      body: { access_token: secret },
      cause: { message: secret },
      status: 502,
    });
    next(error);
  });
  app.get("/api/unexpected", () => {
    throw new Error(secret);
  });
  app.use(safeFinalErrorHandler);
  return { app, logs };
}

it.each([400, 413, 500, 502])(
  "keeps production %s parser/provider failures out of stderr, response and structured logs",
  async (status) => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, logs } = fixture();
    const response =
      status === 400
        ? await request(app)
            .post(`/api/parse?code=${secret}&state=${secret}&realmId=987654321`)
            .set("Authorization", `Bearer ${secret}`)
            .set("Cookie", `session=${secret}`)
            .set("Content-Type", "application/json")
            .send(`{"password":"${secret}"`)
        : status === 413
          ? await request(app)
              .post("/api/parse")
              .send({ access_token: secret.repeat(10) })
          : await request(app).get(
              status === 502 ? "/api/provider" : "/api/unexpected",
            );
    expect(response.status).toBe(status);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body).toEqual({
      error:
        status >= 500
          ? "The request could not be completed."
          : "The request could not be accepted.",
    });
    expect(stderr).not.toHaveBeenCalled();
    const raw = logs.join("\n");
    expect(raw).not.toMatch(
      /SENTINEL|987654321|access_token|password|Bearer|provider\.invalid/,
    );
    const entries = logs.map((value) => JSON.parse(value));
    expect(entries).toContainEqual(
      expect.objectContaining({
        diagnostic: "http_request_failed",
        statusCode: status,
      }),
    );
    expect(entries.some((entry) => entry.req?.pathClass)).toBe(true);
  },
);

it("closes an already-started response without forwarding a raw error", () => {
  const errorLog = vi.fn(),
    destroy = vi.fn(),
    next = vi.fn();
  safeFinalErrorHandler(
    new Error(secret),
    { log: { error: errorLog } } as unknown as Request,
    { headersSent: true, destroy } as unknown as Response,
    next,
  );
  expect(destroy).toHaveBeenCalledOnce();
  expect(next).not.toHaveBeenCalled();
  expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
});

it("ignores a misleading nonfailure status on an unexpected error", () => {
  const errorLog = vi.fn(),
    json = vi.fn(),
    status = vi.fn(() => ({ json }));
  safeFinalErrorHandler(
    Object.assign(new Error(secret), { status: 200 }),
    { log: { error: errorLog } } as unknown as Request,
    { headersSent: false, status } as unknown as Response,
    vi.fn(),
  );
  expect(status).toHaveBeenCalledWith(500);
});
