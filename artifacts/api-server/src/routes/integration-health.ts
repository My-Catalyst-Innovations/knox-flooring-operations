import { workspaceEnvironment } from "@workspace/db/workspace";
import { Router, type IRouter } from "express";
import { db, quickbooksConnectionsTable } from "@workspace/db";
import { getOpenAIModel, getOpenAIUsageToday, hasOpenAI } from "../lib/openai";
import { getTutorialNarrationStatus } from "../lib/tutorial-narration";
import { outlookCalendarStatus } from "../lib/outlook-calendar";
import { availableCommunicationProviders, smsDeliveryCapability } from "../lib/comms";

const router: IRouter = Router();
router.get("/integrations/health", async (_req, res) => {
  const [quickbooks] = await db.select().from(quickbooksConnectionsTable).limit(1);
  const quickbooksDemo = workspaceEnvironment().DEMO_MODE === "true";
  const aiUsage = await getOpenAIUsageToday();
  const narration = getTutorialNarrationStatus();
  const outlook = await outlookCalendarStatus();
  const { mode: deliveryMode, provider: smsProvider } = smsDeliveryCapability();
  const providers = availableCommunicationProviders();
  const configured = [providers.email && "Resend email", smsProvider === "signalwire" && "SignalWire SMS", smsProvider === "twilio" && "Twilio SMS"].filter(Boolean).join(" and ");
  const communicationStatus = deliveryMode === "capture" ? "Simulated" : configured ? "Configured" : "Disconnected";
  const communicationDetail = deliveryMode === "capture" ? "Messages are captured in the Demo Outbox."
    : configured ? `${configured} configured. ${deliveryMode === "allowlist" ? "Delivery is limited to approved recipients." : "Delivery is enabled."}`
      : "Add provider credentials and a verified sender to enable delivery.";
  res.json({
    generatedAt: new Date().toISOString(),
    integrations: [
      { key: "openai", name: "OpenAI Copilots", status: hasOpenAI() ? "Live" : "Simulated", detail: hasOpenAI() ? `Responses API configured with ${getOpenAIModel()}` : "Deterministic fallback is active", metrics: [{ label: "Requests today", value: `${aiUsage.successfulRequests} / ${aiUsage.limit}` }, { label: "Tokens today", value: (aiUsage.inputTokens + aiUsage.outputTokens).toLocaleString() }, { label: "Remaining", value: String(aiUsage.remaining) }] },
      { key: "tutorial_voice", name: "Tutorial Narration", status: narration.provider === "Unavailable" ? "Disconnected" : "Live", detail: narration.provider === "ElevenLabs" ? `ElevenLabs ${narration.voice} · ${narration.model}` : narration.provider === "OpenAI fallback" ? `OpenAI backup narrator · ${narration.voice}` : "Add an ElevenLabs API key and voice ID to enable narration" },
      { key: "quickbooks", name: "QuickBooks Online", status: quickbooks?.status === "connected" ? (workspaceEnvironment().QUICKBOOKS_ENVIRONMENT === "production" ? "Live" : "Sandbox") : quickbooksDemo ? "Simulated" : "Disconnected", detail: quickbooks?.companyName ?? (quickbooksDemo ? "Interactive demo company available in Settings" : "Connect an Intuit sandbox company") },
      { key: "outlook", name: "Outlook Calendar", status: outlook.status === "connected" && outlook.calendar ? "Live" : outlook.configured ? "Configured" : "Disconnected", detail: outlook.status === "connected" && outlook.calendar ? `${outlook.pending.length} booking updates pending` : outlook.configured ? "Authorize a mailbox and select its calendar in Settings." : "Configure the Outlook application to enable calendar connection." },
      { key: "calendar", name: "Google Calendar", status: "Disconnected", detail: "Optional connection. Check Google Calendar settings for the current account status." },
      { key: "measure_square", name: "Measure Square", status: workspaceEnvironment().MEASURE_SQUARE_API_KEY ? "Live" : "Simulated", detail: workspaceEnvironment().MEASURE_SQUARE_API_KEY ? "Measurement sync configured" : "Fixture imports available" },
      { key: "communications", name: "Email & SMS", status: communicationStatus, detail: communicationDetail },
    ],
  });
});
export default router;
