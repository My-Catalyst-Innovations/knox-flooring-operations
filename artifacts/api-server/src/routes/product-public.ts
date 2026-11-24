import { Router } from "express";
import { quickBooksEntryPaths } from "@workspace/domain";
import { publishedPolicy } from "../lib/product-policies";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
export function productPublicRouter(
  publication = () => process.env.WORKS_LEGAL_PUBLICATION_JSON,
) {
  const router = Router();
  // Provider launch/disconnect URLs may carry customer-identifying query values.
  // Never render HTML from that request, reflect it or use it to choose a company.
  router.use((req, res, next) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(req.path).replace(/\/$/, "").toLowerCase();
    } catch {
      if (!/^\/integrations\/quickbooks(?:\/|$)/i.test(req.path)) {
        next();
        return;
      }
      res
        .status(400)
        .set({
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Referrer-Policy": "no-referrer",
        })
        .end();
      return;
    }
    const clean = Object.values(quickBooksEntryPaths).find(
      (path) => path === decoded,
    );
    const publicDocument = ["/privacy", "/terms", "/help/quickbooks"].find(
      (path) => path === decoded,
    );
    if (
      !clean &&
      !publicDocument &&
      !/^\/integrations\/quickbooks(?:\/|$)/i.test(decoded)
    ) {
      next();
      return;
    }
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Referrer-Policy": "no-referrer",
    });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).set("Allow", "GET, HEAD").end();
      return;
    }
    if (!clean && !publicDocument) {
      res.status(404).end();
      return;
    }
    const destination = clean ?? publicDocument!;
    if (req.originalUrl.includes("?") || req.path !== destination) {
      res.status(302).location(destination).end();
      return;
    }
    next();
  });
  for (const [path, kind] of [
    ["/privacy", "privacy"],
    ["/terms", "terms"],
  ] as const) {
    router.get(path, (_req, res) => {
      res.set({
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      });
      const policy = publishedPolicy(kind, publication());
      if (!policy) {
        res
          .status(503)
          .set("Retry-After", "86400")
          .type("html")
          .send(
            '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Policy unavailable — Catalyst Works</title><main><h1>Policy not yet published</h1><p>The operator has not published an approved version of this document. Contact your company owner for your existing agreement.</p><p><a href="/help/quickbooks">Product help</a></p></main></html>',
          );
        return;
      }
      res
        .set("X-Policy-Content-SHA256", policy.contentSha256)
        .type("html")
        .send(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(policy.title)}</title><style>body{font:1rem/1.65 system-ui,sans-serif;max-width:54rem;margin:3rem auto;padding:0 1.25rem;color:#162a2b}h1,h2{line-height:1.2}section{margin:2rem 0}p{white-space:pre-line}a{color:#075c63}</style><main><h1>${escape(policy.title)}</h1><p>Version ${escape(policy.version)}</p>${policy.sections.map((section) => `<section><h2>${escape(section.title)}</h2><p>${escape(section.text)}</p></section>`).join("")}<p><a href="/help/quickbooks">Product help</a></p></main></html>`,
        );
    });
  }
  return router;
}
