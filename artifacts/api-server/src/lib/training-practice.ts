const businessProvider = /^(QUICKBOOKS|OUTLOOK|GOOGLE_CALENDAR|MEASURE_SQUARE|TWILIO|SIGNALWIRE|RESEND|AZURE_EMAIL|SMTP)_|^(REPLIT_CONNECTORS_HOSTNAME|REPL_IDENTITY|WEB_REPL_RENEWAL)$/;

function httpsOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash &&
      !url.username && !url.password && !url.port && url.hostname.includes(".")) return url;
  } catch { /* Invalid deployment configuration keeps practice disabled. */ }
  return null;
}

export function trainingPracticeAccess(env: Readonly<NodeJS.ProcessEnv>, hostname: string, standalone: boolean) {
  const practice = httpsOrigin(env.PRACTICE_WORKSPACE_URL);
  if (!practice) return { enabled: false, url: null };
  const onPracticeHost = practice.hostname === hostname.toLowerCase();
  const enabled = standalone && onPracticeHost && httpsOrigin(env.APP_BASE_URL)?.origin === practice.origin &&
    env.DEMO_MODE === "true" && env.BACKGROUND_WORKERS_ENABLED === "false" && env.COMMS_DELIVERY_MODE === "capture" &&
    env.DEMO_ACCESS_ENABLED !== "true" && !Object.entries(env).some(([name, value]) => Boolean(value?.trim()) && businessProvider.test(name));
  return { enabled: Boolean(enabled), url: onPracticeHost ? null : practice.origin };
}

export function practiceCustomerName(run: { id: string; startedAt: string }) {
  return `Juniper Ridge Practice ${run.id.slice(0, 8)}-${Date.parse(run.startedAt).toString(36)}`;
}

export function hasMeasuredRoom(inputs: { rooms?: unknown }) {
  return Array.isArray(inputs.rooms) && inputs.rooms.some((room: unknown) => {
    if (!room || typeof room !== "object" || !("length" in room) || !("width" in room)) return false;
    return typeof room.length === "number" && Number.isFinite(room.length) && room.length > 0 &&
      typeof room.width === "number" && Number.isFinite(room.width) && room.width > 0;
  });
}
