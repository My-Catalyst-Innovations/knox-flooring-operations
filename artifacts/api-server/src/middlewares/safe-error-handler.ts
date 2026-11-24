import type { ErrorRequestHandler } from "express";
import { logger } from "../lib/logger";
import { safeDiagnostic, safeErrorLog } from "../lib/safe-logging";

/** Do not delegate raw parser/provider errors to Express's stderr final handler. */
export const safeFinalErrorHandler: ErrorRequestHandler = (
  error,
  req,
  res,
  _next,
) => {
  const status = safeErrorLog(error).statusCode;
  const failureStatus =
    typeof status === "number" && status >= 400 ? status : 500;
  (req.log ?? logger).error(
    {
      ...safeDiagnostic("http_request_failed", error),
      ...(!res.headersSent ? { statusCode: failureStatus } : {}),
    },
    "HTTP request failed",
  );
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(failureStatus).json({
    error:
      failureStatus >= 500
        ? "The request could not be completed."
        : "The request could not be accepted.",
  });
};
