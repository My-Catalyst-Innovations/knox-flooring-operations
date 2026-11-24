import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { quickBooksEntryPaths, welcomeContinuation } from "@workspace/domain";
import { candidatePolicy } from "../lib/product-policies";
import { completePublication } from "../lib/policy-review-fixture";
import { productPublicRouter } from "./product-public";

function fixture(publication?: string) {
  const app = express();
  app.use((req, res, next) => {
    if (req.get("host") === "untrusted.invalid") res.status(421).end();
    else next();
  });
  app.use(productPublicRouter(() => publication));
  app.get("/{*path}", (_req, res) =>
    res.type("html").send("<main>Public product shell</main>"),
  );
  return app;
}
describe("non-mutating trusted product entry", () => {
  it.each(Object.values(quickBooksEntryPaths))(
    "cleans identifiers with an empty fixed302: %s",
    async (path) => {
      const response = await request(fixture())
        .get(
          path +
            "?realmId=SENTINEL-REALM&code=SENTINEL-CODE&state=SENTINEL-STATE&next=https://evil.invalid",
        )
        .expect(302);
      expect(response.headers.location).toBe(path);
      expect(response.text).toBe("");
      expect(response.headers["cache-control"]).toBe(
        "no-store, no-cache, must-revalidate",
      );
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(JSON.stringify(response.headers)).not.toContain("SENTINEL");
      await request(fixture())
        .get(path)
        .expect(200, "<main>Public product shell</main>");
      await request(fixture())
        .post(path + "?realmId=SENTINEL")
        .expect(405, "");
    },
  );
  it.each([
    "/INTEGRATIONS/QUICKBOOKS/DISCONNECT/",
    "/integrations/quickbooks/%64isconnect",
    "/integrations%2Fquickbooks%2Freconnect",
  ])(
    "canonicalizes encoded/case entry %s without reflecting parameters",
    async (path) => {
      const response = await request(fixture())
        .get(path + "?realmId=SENTINEL")
        .expect(302);
      expect(response.headers.location).toMatch(
        /^\/integrations\/quickbooks\/(?:disconnect|reconnect)$/,
      );
      expect(response.text).toBe("");
    },
  );
  it("does not render an unknown/malformed provider entry or bypass the workspace boundary", async () => {
    await request(fixture())
      .get("/integrations/quickbooks/unknown?realmId=SENTINEL")
      .expect(404, "");
    await request(fixture())
      .get("/integrations/quickbooks/%XX?code=SENTINEL")
      .expect(400, "");
    await request(fixture())
      .get(quickBooksEntryPaths.disconnect + "?realmId=SENTINEL")
      .set("Host", "untrusted.invalid")
      .expect(421);
  });
});
describe("unapproved public legal content stays unavailable", () => {
  it.each(["/privacy", "/terms"])(
    "returns503 without leaking draft wording at %s",
    async (path) => {
      const response = await request(fixture()).get(path).expect(503);
      expect(response.text).toContain("Policy not yet published");
      expect(response.text).not.toContain("OPERATOR REVIEW REQUIRED");
      expect(response.text).not.toContain("Governing law");
      await request(fixture()).head(path).expect(503);
    },
  );
  it("cannot publish via query/header inputs or an authenticated-looking visitor", async () => {
    const response = await request(fixture())
      .get("/privacy?approved=true&realmId=SENTINEL")
      .set("Cookie", "owner=true")
      .expect(302);
    expect(response.headers.location).toBe("/privacy");
    expect(response.text).toBe("");
    await request(fixture())
      .get("/privacy")
      .set("X-Policy-Approved", "true")
      .expect(503);
    await request(fixture())
      .post("/terms")
      .send(completePublication())
      .expect(405);
  });
  it("publishes only the individually approved exact body, escaped and without external resources", async () => {
    const config = completePublication();
    config.fields.legalEntity =
      'Fictional <script>alert("SENTINEL")</script> Entity';
    config.documents.privacy.contentSha256 = candidatePolicy(
      "privacy",
      config.fields,
    ).contentSha256;
    config.documents.terms.approved = false;
    const response = await request(fixture(JSON.stringify(config)))
      .get("/privacy")
      .expect(200);
    expect(response.headers["x-policy-content-sha256"]).toBe(
      config.documents.privacy.contentSha256,
    );
    expect(response.text).toContain("&lt;script&gt;");
    expect(response.text).not.toContain("<script>");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(response.text).not.toContain("OPERATOR REVIEW REQUIRED");
    await request(fixture(JSON.stringify(config)))
      .get("/terms")
      .expect(503);
    config.fields.legalEntity += " Changed";
    await request(fixture(JSON.stringify(config)))
      .get("/privacy")
      .expect(503);
  });
});
it.each([
  "?continue=https://evil.invalid",
  "?continue=//evil.invalid",
  "?continue=/settings",
  "?next=https://evil.invalid",
  "?continue=quickbooks_connect&continue=quickbooks_disconnect",
  "?continue=__proto__",
  "?continue=%XX",
])("refuses untrusted login continuation %s", (search) => {
  expect(welcomeContinuation(search)).toBe("/");
});
it.each(Object.keys(quickBooksEntryPaths))(
  "accepts only closed login intent %s",
  (intent) => {
    expect(welcomeContinuation(`?continue=quickbooks_${intent}`)).toBe(
      quickBooksEntryPaths[intent as keyof typeof quickBooksEntryPaths],
    );
  },
);
