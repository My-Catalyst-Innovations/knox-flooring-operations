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

const app: Express = express();
const customerLinkPath = /^\/(?:api\/public\/(?:jobs|quotes)|p|q)\/[^/]+/i;

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0].replace(customerLinkPath, "/[customer-link]"),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.set("trust proxy", 1);
app.use(workspaceBoundary);
app.use((req, res, next) => {
  if (customerLinkPath.test(req.path)) {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  }
  next();
});
app.use(cors((_req, done) => done(null, { origin: workspaceEnvironment().APP_BASE_URL || true, credentials: true })));
app.use(express.json({
  limit: "1mb",
  type: ["application/json", "application/cloudevents-batch+json"],
  verify: (req, _res, buffer) => { (req as express.Request).rawBody = Buffer.from(buffer); },
}));
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

export default app;
