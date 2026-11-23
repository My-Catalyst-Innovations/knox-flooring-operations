import { timingSafeEqual } from "node:crypto";
import { PlatformError } from "./config.mjs";

export const platformCookie = "__Host-catalyst_platform";
export function createPlatformRouter({
  express,
  config,
  getServices,
  readiness,
  probe,
  readOnly = false,
}) {
  const router = express.Router();
  const run = (action) => (req, res, next) =>
    Promise.resolve(action(req, res)).catch(next);
  router.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    const isProbe = req.method === "GET" && req.path === "/tenant-probe";
    const expected = config.origin ? new URL(config.origin).host : null;
    if (!isProbe && expected && req.get("host")?.toLowerCase() !== expected) {
      res.status(421).json({ error: "Use the company account website." });
      return;
    }
    if (readOnly && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      res
        .status(503)
        .set("Retry-After", "60")
        .json({
          error: "Company account changes are unavailable during recovery.",
        });
      return;
    }
    if (req.get("origin") && req.get("origin") !== config.origin) {
      res.status(403).json({ error: "Use the company account website." });
      return;
    }
    next();
  });
  router.get(
    "/readiness",
    run(async (_req, res) => res.json(await readiness())),
  );
  router.get(
    "/tenant-probe",
    run(async (req, res) => res.json(await probe(req.get("host")))),
  );
  // Raw bytes must be read before any JSON parsing. Webhook signatures do not use browser sessions.
  router.post(
    "/stripe/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    run(async (req, res) => {
      const { billing, kick } = await getServices();
      res.json(await billing.webhook(req.body, req.get("stripe-signature")));
      kick();
    }),
  );
  router.post(
    "/email/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    run(async (req, res) => {
      const { mail } = await getServices();
      await mail.webhook(req.body, {
        id: req.get("svix-id"),
        timestamp: req.get("svix-timestamp"),
        signature: req.get("svix-signature"),
      });
      res.sendStatus(204);
    }),
  );
  router.use(express.json({ limit: "32kb", strict: true }));
  router.post(
    "/signup",
    run(async (req, res) => {
      const { service, kick } = await getServices();
      res.status(202).json(await service.signup(req.body, req.ip));
      kick();
    }),
  );
  router.post(
    "/auth/request",
    run(async (req, res) => {
      const { service, kick } = await getServices();
      res.status(202).json(await service.requestLogin(req.body?.email, req.ip));
      kick();
    }),
  );
  router.post(
    "/auth/verify",
    run(async (req, res) => {
      const { store } = await getServices();
      await store.rate("verify-ip", req.ip, 30);
      const result = await store.consumeToken(req.body?.token);
      res.cookie(platformCookie, result.rawSession, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 12 * 3600_000,
      });
      res.json({
        csrfToken: result.csrf,
        organizationId: result.organizationId,
      });
    }),
  );
  router.use((req, _res, next) => {
    void (async () => {
      const { store } = await getServices();
      const cookie = String(req.get("cookie") ?? "")
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${platformCookie}=`));
      let value;
      try {
        value = cookie
          ? decodeURIComponent(cookie.slice(platformCookie.length + 1))
          : null;
      } catch {
        value = null;
      }
      const account = await store.session(value);
      if (!account)
        throw new PlatformError(
          401,
          "authentication",
          "Sign in to your company account.",
        );
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const actual = Buffer.from(req.get("x-platform-csrf") ?? ""),
          expected = Buffer.from(account.csrf_token);
        if (
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        )
          throw new PlatformError(
            403,
            "csrf",
            "Refresh your company account before making changes.",
          );
      }
      req.platformAccount = account;
    })().then(() => next(), next);
  });
  // The explicit async authentication middleware calls next only after successful verification.
  router.get(
    "/account",
    run(async (req, res) =>
      res.json(
        await (await getServices()).service.profile(req.platformAccount),
      ),
    ),
  );
  router.patch(
    "/account",
    run(async (req, res) => {
      const { service, kick } = await getServices();
      res.json(await service.updateAccount(req.platformAccount, req.body));
      kick();
    }),
  );
  router.post(
    "/auth/logout",
    run(async (req, res) => {
      const { store } = await getServices();
      await store.query("DELETE FROM platform_sessions WHERE id=$1", [
        req.platformAccount.session_id,
      ]);
      res
        .clearCookie(platformCookie, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
        })
        .sendStatus(204);
    }),
  );
  router.patch(
    "/organizations/:id",
    run(async (req, res) =>
      res.json(
        await (
          await getServices()
        ).service.updateCompany(req.platformAccount, req.params.id, req.body),
      ),
    ),
  );
  router.post(
    "/organizations/:id/checkout",
    run(async (req, res) =>
      res.json(
        await (
          await getServices()
        ).service.checkout(
          req.platformAccount,
          req.params.id,
          req.body?.planKey,
        ),
      ),
    ),
  );
  router.post(
    "/organizations/:id/portal",
    run(async (req, res) =>
      res.json(
        await (
          await getServices()
        ).service.portal(req.platformAccount, req.params.id),
      ),
    ),
  );
  router.post(
    "/organizations/:id/retry",
    run(async (req, res) => {
      const { store } = await getServices(),
        org = await store.organization(req.params.id, req.platformAccount.id);
      if (!["paid", "trial"].includes(org.entitlement))
        throw new PlatformError(
          409,
          "entitlement",
          "Review this company subscription before retrying setup.",
        );
      await store.query(
        "UPDATE platform_provisioning_jobs SET next_attempt_at=now(),error_code=NULL WHERE organization_id=$1 AND (locked_until IS NULL OR locked_until<now())",
        [org.id],
      );
      res.json({
        message:
          "Company setup retry requested. Its current subscription and infrastructure will be verified again.",
      });
    }),
  );
  router.use((error, _req, res, _next) => {
    const status = error instanceof PlatformError ? error.status : 503;
    res
      .status(status)
      .json({
        error:
          status >= 500
            ? "Company account services are not ready. Please try again later or contact Catalyst Innovations."
            : error instanceof PlatformError
              ? error.message
              : "Company account services are temporarily unavailable.",
        code:
          error instanceof PlatformError ? error.code : "platform_unavailable",
      });
  });
  return router;
}
