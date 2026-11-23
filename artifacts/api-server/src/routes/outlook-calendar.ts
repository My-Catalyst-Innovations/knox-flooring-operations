import { Router } from "express";
import { z } from "zod";
import { requireOwner } from "../middlewares/auth";
import { domainRoute, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import {
  getOutlookConfig,
  getOutlookAuthorization,
  OutlookError,
  startOutlookAuthorization,
} from "../lib/outlook-graph";
import {
  disconnectOutlookCalendar,
  finishOutlookConnection,
  listOutlookCalendars,
  outlookCalendarStatus,
  queueUpcomingOutlookBookings,
  requestOutlookBookingSync,
  selectOutlookCalendar,
} from "../lib/outlook-calendar";

const router = Router();
const base = "/calendar/outlook";
const cookieName = "catalyst_outlook_authorization";
const cookieOptions = (secure: boolean) => ({
  httpOnly: true,
  secure,
  sameSite: "lax" as const,
  path: `/api${base}/callback`,
});

router.use(base, requireOwner);
router.get(
  `${base}/status`,
  domainRoute(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await outlookCalendarStatus());
  }),
);

router.post(
  `${base}/connect`,
  domainRoute(async (req, res) => {
    const config = getOutlookConfig();
    if (!config)
      throw new DomainError(503, "Outlook is not configured on this server.");
    const options = parse(
      z.object({ mail: z.boolean().optional() }).strict(),
      req.body ?? {},
    );
    const authorization = startOutlookAuthorization(
      config,
      req.auth!.userId,
      req.auth!.csrfToken,
      Date.now(),
      options,
    );
    res.setHeader("Cache-Control", "no-store");
    res.cookie(cookieName, authorization.cookie, {
      ...cookieOptions(config.redirectUri.startsWith("https:")),
      maxAge: authorization.maxAge,
    });
    res.json({ authorizationUrl: authorization.authorizationUrl });
  }),
);

router.get(
  `${base}/callback`,
  domainRoute(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const config = getOutlookConfig();
    res.clearCookie(
      cookieName,
      cookieOptions(config?.redirectUri.startsWith("https:") ?? req.secure),
    );
    const cookie = req.cookies?.[cookieName];
    const { state, code } = req.query;
    const authorization =
      config && typeof cookie === "string" && typeof state === "string"
        ? getOutlookAuthorization(
            config,
            cookie,
            state,
            req.auth!.userId,
            req.auth!.csrfToken,
          )
        : null;
    if (!config || !authorization || typeof code !== "string" || !code) {
      res.redirect("/settings?outlook=invalid");
      return;
    }
    try {
      await finishOutlookConnection(
        config,
        code,
        authorization.verifier,
        authorization.scope,
      );
      res.redirect("/settings?outlook=connected");
    } catch (error) {
      if (!(error instanceof OutlookError))
        req.log.error("Outlook authorization could not be saved");
      res.redirect(
        `/settings?outlook=${error instanceof OutlookError && error.status === 409 ? "account_mismatch" : "failed"}`,
      );
    }
  }),
);

router.get(
  `${base}/calendars`,
  domainRoute(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await listOutlookCalendars());
  }),
);

router.put(
  `${base}/calendar`,
  domainRoute(async (req, res) => {
    const { calendarId } = parse(
      z.object({ calendarId: z.string().trim().min(1).max(2048) }),
      req.body,
    );
    res.json(await selectOutlookCalendar(calendarId));
  }),
);

router.post(
  `${base}/disconnect`,
  domainRoute(async (_req, res) => {
    await disconnectOutlookCalendar();
    res.status(204).end();
  }),
);

router.post(
  `${base}/publish-upcoming`,
  domainRoute(async (_req, res) => {
    const queued = await queueUpcomingOutlookBookings();
    requestOutlookBookingSync();
    res.status(202).json({ queued });
  }),
);

router.post(
  `${base}/retry`,
  domainRoute(async (_req, res) => {
    const status = await outlookCalendarStatus();
    if (status.status !== "connected")
      throw new DomainError(409, "Connect Outlook before retrying bookings.");
    requestOutlookBookingSync();
    res.status(202).json({ accepted: true });
  }),
);

export default router;
