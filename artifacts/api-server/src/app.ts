import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import cookieParser from "cookie-parser";
import router from "./routes";
import { logger } from "./lib/logger";
import { recoveryReadOnly } from "./middlewares/recovery";
import { workspaceBoundary } from "./middlewares/workspace";
import { workspaceEnvironment } from "@workspace/db/workspace";
import { platform } from "./platform";
import { apiSecurity } from "./middlewares/api-security";
import { safeErrorLog, safeRequestLog, safeResponseLog } from "./lib/safe-logging";
import { safeFinalErrorHandler } from "./middlewares/safe-error-handler";
import { productPublicRouter } from "./routes/product-public";

const app: Express = express();
const customerLinkPath = /^\/(?:api\/public\/(?:jobs|quotes)|p|q)\/[^/]+/i;

app.use(apiSecurity);
app.use(
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
app.set("trust proxy", 1);
app.use("/api/platform", platform.router);
app.use(workspaceBoundary);
app.use(productPublicRouter());
app.use((req, res, next) => {
  if (customerLinkPath.test(req.path)) {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  }
  next();
});
app.use(
  cors((_req, done) =>
    done(null, {
      origin: workspaceEnvironment().APP_BASE_URL || true,
      credentials: true,
    }),
  ),
);
const jsonOptions = {
  type: ["application/json", "application/cloudevents-batch+json"],
  verify: (req: express.Request, _res: express.Response, buffer: Buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
};
const defaultJson = express.json({ ...jsonOptions, limit: "1mb" });
// A <=1 MiB UTF-8 CSV can approach 2 MiB after JSON quote escaping. Retain the
// existing limit everywhere else; the archive parser separately caps source bytes.
const archiveJson = express.json({ ...jsonOptions, limit: "3mb" });
app.use((req, res, next) =>
  (req.method === "POST" && ["/api/legacy-history/imports/preview", "/api/supplier-imports/preview", "/api/active-job-imports/preview"].includes(req.path)
    ? archiveJson
    : defaultJson)(req, res, next),
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/api", recoveryReadOnly, router);

if (process.env.NODE_ENV === "production") {
  const frontendDir = path.resolve(
    process.cwd(),
    "artifacts/knox-flooring/dist/public",
  );

  app.use(express.static(frontendDir));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      next();
      return;
    }

    res.sendFile(path.join(frontendDir, "index.html"));
  });
}

app.use(safeFinalErrorHandler);
export default app;
