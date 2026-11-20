import express from "express";
import { createHash } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  lookup: vi.fn(),
  recent: vi.fn(),
  saveToken: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@workspace/db", async () => {
  const schema = await import("../../../../lib/db/src/schema/security");
  const client = {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          table === schema.usersTable
            ? { for: state.lookup }
            : { orderBy: () => ({ limit: state.recent }) },
      }),
    }),
    insert: (table: unknown) => ({
      values:
        table === schema.passwordResetTokensTable
          ? state.saveToken
          : state.audit,
    }),
  };
  const db = {
    ...client,
    transaction: (fn: (tx: typeof client) => Promise<unknown>) => fn(client),
  };
  return { db, ...schema };
});

import authRouter from "./auth";

const app = express().use(express.json(), authRouter);
const fetch = vi.fn<typeof globalThis.fetch>();
const genericMessage = {
  message:
    "If an eligible account matches, you’ll receive a password reset link.",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("DEMO_ACCESS_ENABLED", "false");
  vi.stubEnv("PASSWORD_RESET_EMAIL_ENABLED", "true");
  vi.stubEnv("APP_BASE_URL", "https://works.example.com");
  vi.stubEnv("RESEND_API_KEY", "fake");
  vi.stubEnv("RESEND_FROM_EMAIL", "sender@example.com");
  vi.stubEnv("RESEND_REPLY_TO_EMAIL", "");
  state.recent.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("responds identically for an active account, an unknown account, and an invalid email", async () => {
  state.lookup
    .mockResolvedValueOnce([{ id: "known-user-1" }])
    .mockResolvedValueOnce([]);
  fetch.mockResolvedValueOnce(Response.json({ id: "reset-mail" }));
  const known = await request(app)
    .post("/auth/password/forgot")
    .send({ email: "staff@example.com" })
    .expect(202);
  const unknown = await request(app)
    .post("/auth/password/forgot")
    .send({ email: "unknown@example.com" })
    .expect(202);
  const invalid = await request(app)
    .post("/auth/password/forgot")
    .send({ email: "invalid-email" })
    .expect(202);
  expect(known.body).toEqual(genericMessage);
  expect(unknown.body).toEqual(known.body);
  expect(invalid.body).toEqual(known.body);
  expect(known.headers["cache-control"]).toBe("no-store");

  await vi.waitFor(() =>
    expect(state.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.password_reset_submitted" }),
    ),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(state.saveToken).toHaveBeenCalledTimes(1);
  const [, outbound] = fetch.mock.calls[0];
  const resetUrl = JSON.parse(String(outbound?.body)).text.match(
    /https:\/\/\S+/,
  )?.[0];
  const token = new URLSearchParams(new URL(resetUrl).hash.slice(1)).get(
    "reset",
  )!;
  expect(token).toMatch(/^[a-zA-Z0-9_-]{43}$/);
  expect(state.saveToken).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: "known-user-1",
      tokenHash: createHash("sha256").update(token).digest("hex"),
    }),
  );
  expect(
    JSON.stringify([
      known.body,
      state.saveToken.mock.calls,
      state.audit.mock.calls,
    ]),
  ).not.toContain(token);
});

it.each(["DEMO_MODE", "DEMO_ACCESS_ENABLED"])(
  "does not look up accounts or send reset links with %s enabled",
  async (flag) => {
    vi.stubEnv(flag, "true");
    const demo = await request(app)
      .post("/auth/password/forgot")
      .send({ email: "staff@example.com" })
      .expect(202);
    expect(demo.body).toEqual(genericMessage);
    expect(state.lookup).not.toHaveBeenCalled();
    expect(state.saveToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("uses the stored request history to limit reset email bursts", async () => {
  state.lookup.mockResolvedValue([{ id: "known-user-2" }]);
  state.recent.mockResolvedValue([{ createdAt: new Date().toISOString() }]);
  await request(app)
    .post("/auth/password/forgot")
    .send({ email: "staff@example.com" })
    .expect(202);
  await vi.waitFor(() => expect(state.recent).toHaveBeenCalled());
  expect(state.saveToken).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
