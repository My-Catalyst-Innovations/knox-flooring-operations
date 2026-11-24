import { safeDiagnostic } from "./safe-logging";
import { logger } from "./logger";
import type { MeasurementRoom, MeasurementProduct } from "@workspace/db";
import { workspaceEnvironment } from "@workspace/db/workspace";

/**
 * Measure Square's automated data connection is enterprise-only and requires
 * special API access/credentials from the account owner. We read those from the
 * environment so nothing is ever hard-coded. When they are absent the whole
 * integration degrades gracefully to a clear "not connected" state instead of
 * erroring — the app still works with locally-entered and demo measurements.
 */
const apiKey = () => workspaceEnvironment().MEASURE_SQUARE_API_KEY;
const apiUrl = () => (
  workspaceEnvironment().MEASURE_SQUARE_API_URL || "https://api.measuresquare.com/v1"
).replace(/\/$/, "");

export class MeasureSquareError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "MeasureSquareError";
    this.status = status;
  }
}

export function isConfigured(): boolean {
  return Boolean(apiKey()?.trim());
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey()}`,
    "Content-Type": "application/json",
  };
}

const NOT_CONNECTED_MESSAGE =
  "Measure Square is not connected. Add your Measure Square API credentials " +
  "(MEASURE_SQUARE_API_KEY) to enable automatic two-way sync. Measure Square's " +
  "data connection is enterprise-only — request API access from your Measure " +
  "Square account.";

export interface MeasureSquareStatus {
  connected: boolean;
  configured: boolean;
  message: string;
}

export async function getStatus(): Promise<MeasureSquareStatus> {
  if (!isConfigured()) {
    return { connected: false, configured: false, message: NOT_CONNECTED_MESSAGE };
  }
  try {
    const res = await fetch(`${apiUrl()}/ping`, { headers: authHeaders() });
    if (res.ok) {
      return {
        connected: true,
        configured: true,
        message: "Connected to Measure Square.",
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        connected: false,
        configured: true,
        message:
          "Measure Square rejected the API credentials. Verify your API key has data-sync access.",
      };
    }
    return {
      connected: false,
      configured: true,
      message: `Measure Square responded with an error (HTTP ${res.status}).`,
    };
  } catch (err) {
    logger.warn(safeDiagnostic("measure_square_status_failed", err), "Measure Square status probe failed");
    return {
      connected: false,
      configured: true,
      message:
        "Could not reach Measure Square. Check the network connection or MEASURE_SQUARE_API_URL.",
    };
  }
}

/** Normalized shape exchanged with Measure Square. */
export interface ExternalMeasurement {
  externalId: string;
  label: string;
  rooms: MeasurementRoom[];
  products: MeasurementProduct[];
  totalSqft: number;
  total: number;
  measuredDate?: string;
  /** Optional cross-references Measure Square may echo back. */
  leadId?: string;
  jobId?: string;
  /**
   * Customer name as it appears in Measure Square. Used to reconcile a
   * measurement back to a Knox lead/job when no internal id is supplied.
   */
  customerName?: string;
}

export interface PushMeasurementInput {
  externalId?: string | null;
  label: string;
  rooms: MeasurementRoom[];
  products: MeasurementProduct[];
  totalSqft: number;
  total: number;
  measuredDate?: string | null;
  leadId?: string | null;
  jobId?: string | null;
}

/** Pull all measurements from Measure Square. Requires a live connection. */
export async function pullMeasurements(): Promise<ExternalMeasurement[]> {
  if (!isConfigured()) {
    throw new MeasureSquareError(NOT_CONNECTED_MESSAGE, 503);
  }
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/measurements`, { headers: authHeaders() });
  } catch (err) {
    logger.warn(safeDiagnostic("measure_square_pull_failed", err), "Measure Square pull request failed");
    throw new MeasureSquareError(
      "Could not reach Measure Square to pull measurements.",
      503,
    );
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new MeasureSquareError(
        "Measure Square rejected the API credentials.",
        503,
      );
    }
    throw new MeasureSquareError(
      `Measure Square pull failed (HTTP ${res.status}).`,
      502,
    );
  }
  const data = (await res.json()) as { measurements?: ExternalMeasurement[] };
  return data.measurements ?? [];
}

/** Push one measurement to Measure Square, returning its external id. */
export async function pushMeasurement(
  input: PushMeasurementInput,
): Promise<{ externalId: string }> {
  if (!isConfigured()) {
    throw new MeasureSquareError(NOT_CONNECTED_MESSAGE, 503);
  }
  const method = input.externalId ? "PUT" : "POST";
  const path = input.externalId
    ? `${apiUrl()}/measurements/${encodeURIComponent(input.externalId)}`
    : `${apiUrl()}/measurements`;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: authHeaders(),
      body: JSON.stringify(input),
    });
  } catch (err) {
    logger.warn(safeDiagnostic("measure_square_push_failed", err), "Measure Square push request failed");
    throw new MeasureSquareError(
      "Could not reach Measure Square to push the measurement.",
      503,
    );
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new MeasureSquareError(
        "Measure Square rejected the API credentials.",
        503,
      );
    }
    throw new MeasureSquareError(
      `Measure Square push failed (HTTP ${res.status}).`,
      502,
    );
  }
  const data = (await res.json()) as { id?: string; externalId?: string };
  const externalId = data.externalId ?? data.id ?? input.externalId ?? "";
  return { externalId };
}
