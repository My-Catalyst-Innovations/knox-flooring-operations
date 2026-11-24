import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoveryReadOnly } from "./recovery";

const app = express().use("/api", recoveryReadOnly, (_req, res) => res.json({ reached: true }));
describe("read-only recovery boundary", () => {
  beforeEach(() => { vi.stubEnv("READ_ONLY_RECOVERY", "true"); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it("keeps authentication and business reads available", async () => {
    for (const path of ["/jobs", "/customers/one", "/jobs/one/labor", "/healthz", "/auth/session", "/auth/options", "/auth/profile"]) expect((await request(app).get(`/api${path}`)).status).toBe(200);
    expect((await request(app).post("/api/auth/login")).status).toBe(200);
    expect((await request(app).post("/api/auth/logout")).status).toBe(200);
  });
  it("blocks business mutations, demo entry, role switching and integration side effects", async () => {
    for (const path of ["/jobs", "/inventory/movements", "/auth/demo", "/auth/persona", "/auth/options"]) {
      const response = await request(app).post(`/api${path}`); expect(response.status).toBe(503); expect(response.body.code).toBe("READ_ONLY_RECOVERY");
    }
    expect((await request(app).patch("/api/settings")).status).toBe(503);
    expect((await request(app).patch("/api/auth/profile")).status).toBe(503);
    expect((await request(app).delete("/api/products/one")).status).toBe(503);
    for (const path of ["/quickbooks/connect", "/google-calendar/status", "/public/quotes/token", "/ai/estimate"]) expect((await request(app).get(`/api${path}`)).status).toBe(503);
  });
  it("does not affect the normal release", async () => {
    vi.stubEnv("READ_ONLY_RECOVERY", "false");
    expect((await request(app).post("/api/jobs")).status).toBe(200);
  });
  it("blocks preference reconciliation lookups before a ledger writer or provider can run", async () => {
    const ledgerWrite=vi.fn(),provider=vi.fn();
    const guarded=express().use("/api",recoveryReadOnly,(_req,res)=>{ledgerWrite();provider();res.json({reconciled:true});});
    for(const method of ["get","head"] as const){
      for(const path of ["/sms-preferences/recipient?to=%2B15005550040","/SMS-PREFERENCES/recipient?to=%2B15005550040","/sms-preferences/recipient/?to=%2B15005550040"]){
        const response=await request(guarded)[method]("/api"+path);expect(response.status).toBe(503);
        expect(response.headers["x-catalyst-mode"]).toBe("read-only-recovery");
        if(method==="get")expect(response.body.code).toBe("READ_ONLY_RECOVERY");
      }
    }
    expect(ledgerWrite).not.toHaveBeenCalled();expect(provider).not.toHaveBeenCalled();
  });
});
