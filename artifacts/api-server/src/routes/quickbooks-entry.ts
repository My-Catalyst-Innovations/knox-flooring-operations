import { Router } from "express";
import { workspaceEnvironment } from "@workspace/db/workspace";
import {
  getConnection,
  quickBooksRevocationRetryAvailable,
} from "../lib/quickbooks";
import { requireOwner } from "../middlewares/auth";
import { domainRoute } from "../lib/domain-http";

const router = Router();
/** Read only the active company DB. No query identifier can select or revoke a grant. */
router.get(
  "/quickbooks/entry-status",
  requireOwner,
  domainRoute(async (req, res) => {
    if (Object.keys(req.query).length) {
      res.status(400).json({
        error:
          "This endpoint does not accept company selectors or query parameters.",
      });
      return;
    }
    const environment = workspaceEnvironment();
    const configured = Boolean(
      environment.QUICKBOOKS_CLIENT_ID &&
      environment.QUICKBOOKS_CLIENT_SECRET &&
      environment.QUICKBOOKS_REDIRECT_URI &&
      environment.QUICKBOOKS_ENCRYPTION_KEY,
    );
    const connection = await getConnection();
    const revocations = {
      revocation_pending: "pending",
      revocation_unknown: "unknown",
      revocation_failed: "failed",
      revocation_confirmed: "confirmed",
    } as const;
    const revocation =
      connection && Object.hasOwn(revocations, connection.readinessStatus)
        ? revocations[connection.readinessStatus as keyof typeof revocations]
        : connection
          ? "not_requested"
          : "not_connected";
    const localUseStopped = connection?.status === "disconnected";
    const inconsistent =
      connection && revocation !== "not_requested" && !localUseStopped;
    const status = !connection
      ? configured
        ? "not_connected"
        : "not_configured"
      : !inconsistent &&
          ["connected", "reconnect_required", "disconnected"].includes(
            connection.status,
          )
        ? connection.status
        : "error";
    res.json({
      configured,
      connection: {
        connected: status === "connected",
        status,
        localUseStopped,
        revocationRetryAvailable:
          quickBooksRevocationRetryAvailable(connection),
        companyName: connection?.companyName ?? null,
        environment:
          connection?.environment === "sandbox" ||
          connection?.environment === "production"
            ? connection.environment
            : null,
        revocation,
      },
    });
  }),
);
export default router;
