import express from "express";
import request from "supertest";
import { expect, it } from "vitest";
import { apiSecurity } from "./api-security";

const app = express().use(apiSecurity);
app.use("/api", express.json({ limit: "100b" }));
app.get("/api/default", (_req, res) => res.json({ fixture: true }));
app.get("/api/auth/session", (_req, res) =>
  res.status(401).json({ error: "Sign in" }),
);
app.get("/api/download", (_req, res) => {
  res
    .set("Cache-Control", "private, max-age=7200")
    .send("synthetic private file");
});
app.get("/api/head-object", (_req, res) => {
  res.writeHead(200, {
    "cache-control": "public, max-age=3600",
    "referrer-policy": "unsafe-url",
    "X-Fixture": "retained",
  });
  res.end();
});
app.get("/api/head-array", (_req, res) => {
  res.writeHead(200, "OK", [
    "Cache-Control",
    "public",
    "Pragma",
    "public",
    "Expires",
    "future",
    "X-Fixture",
    "retained",
  ]);
  res.end();
});
app.post("/api/parse", (_req, res) => res.json({ accepted: true }));
app.get("/assets/app-01234567.js", (_req, res) =>
  res
    .set("Cache-Control", "public, max-age=31536000, immutable")
    .send("/* public fixture */"),
);

it.each([
  ["/api/default", 200],
  ["/api/auth/session", 401],
  ["/api/missing", 404],
  ["/API/default?realmId=SENTINEL-REALM", 200],
  ["/api/download", 200],
  ["/api/head-object", 200],
  ["/api/head-array", 200],
])(
  "keeps default API/auth/error/download responses private: %s",
  async (path, status) => {
    const response = await request(app).get(path).expect(status);
    expect(response.headers["cache-control"]).toBe(
      "no-store, no-cache, must-revalidate",
    );
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.headers.expires).toBe("0");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    if (path.startsWith("/api/head"))
      expect(response.headers["x-fixture"]).toBe("retained");
  },
);
it("applies before malformed/oversized body parsing errors", async () => {
  for (const payload of [
    '{"invalid":',
    JSON.stringify({ data: "x".repeat(101) }),
  ]) {
    const response = await request(app)
      .post("/api/parse")
      .set("Content-Type", "application/json")
      .send(payload);
    expect([400, 413]).toContain(response.status);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  }
});
it("preserves immutable public asset caching", async () => {
  const response = await request(app)
    .get("/assets/app-01234567.js")
    .expect(200);
  expect(response.headers["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(response.headers.pragma).toBeUndefined();
});
