const optedOut = "SMS opt-out";
const optedIn = "SMS opt-in request";
const pendingStop = "SMS opt-out pending provider timestamp";
const pendingStart = "SMS opt-in request awaiting verification";

const stop = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
]);
const start = new Set(["START", "UNSTOP"]);

export function smsConsentCommand(body: string) {
  const word = body.trim().toUpperCase();
  return stop.has(word) ? "stop" : start.has(word) ? "start" : null;
}

export function smsConsentSubject(
  command: "stop" | "start",
  verified: boolean,
) {
  return command === "stop"
    ? verified
      ? optedOut
      : pendingStop
    : verified
      ? optedIn
      : pendingStart;
}
