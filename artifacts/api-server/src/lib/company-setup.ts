import { count, countDistinct, eq, sql } from "drizzle-orm";
import {
  db,
  settingsTable,
  warehousesTable,
  warehouseBinsTable,
  productsTable,
  supplierProductAliasesTable,
  outlookCalendarConnectionTable as outlook,
  microsoftFilesConnectionTable as files,
  quickbooksConnectionsTable as quickbooks,
} from "@workspace/db";
import { workspaceEnvironment } from "@workspace/db/workspace";
import { getOutlookConfig, hasOutlookMailScope } from "./outlook-graph";
import {
  getMicrosoftFilesConfig,
  hasSelectedFilesScope,
} from "./microsoft-files-graph";
import { emailDeliveryCapability, smsDeliveryCapability } from "./comms";
import {
  companyConfigurationExport,
  companySetupReadiness,
  savedAccountingGrant,
  savedOutlookCalendarScope,
} from "./company-configuration";
import { DomainError } from "./operations-rules";

// The export query never reads whole settings rows, business records, users,
// connection tables or environment variables. New columns are excluded by default.
export const companyConfigurationFields = {
  companyName: settingsTable.companyName,
  address: settingsTable.address,
  phone: settingsTable.phone,
  email: settingsTable.email,
  website: settingsTable.website,
  customerAccentColor: settingsTable.customerAccentColor,
  leadStages: settingsTable.leadStages,
  transitionPolicy: settingsTable.transitionPolicy,
  estimatePolicy: settingsTable.estimatePolicy,
  defaultWasteFactor: settingsTable.defaultWasteFactor,
  defaultLaborRateLVP: settingsTable.defaultLaborRateLVP,
  defaultLaborRateHardwood: settingsTable.defaultLaborRateHardwood,
  defaultLaborRateCarpet: settingsTable.defaultLaborRateCarpet,
  defaultLaborRateTile: settingsTable.defaultLaborRateTile,
  commissionBasis: settingsTable.commissionBasis,
  defaultCommissionRate: settingsTable.defaultCommissionRate,
};
async function savedConfiguration() {
  const [settings] = await db
    .select(companyConfigurationFields)
    .from(settingsTable)
    .where(eq(settingsTable.id, 1))
    .limit(1);
  return settings ?? null;
}
export async function exportSavedCompanyConfiguration() {
  const settings = await savedConfiguration();
  if (!settings)
    throw new DomainError(
      404,
      "Save company settings before exporting a configuration.",
    );
  return companyConfigurationExport(settings);
}
export function quickBooksSetupConfigured(env: Readonly<NodeJS.ProcessEnv>) {
  if (
    !env.QUICKBOOKS_CLIENT_ID?.trim() ||
    !env.QUICKBOOKS_CLIENT_SECRET?.trim() ||
    !env.QUICKBOOKS_ENCRYPTION_KEY?.trim() ||
    !["sandbox", "production"].includes(env.QUICKBOOKS_ENVIRONMENT ?? "")
  )
    return false;
  try {
    const callback = new URL(env.QUICKBOOKS_REDIRECT_URI ?? "");
    const base = new URL(env.APP_BASE_URL ?? "");
    const local =
      callback.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname);
    return (
      (callback.protocol === "https:" || local) &&
      callback.origin === base.origin &&
      callback.pathname === "/api/quickbooks/callback" &&
      !callback.username &&
      !callback.password &&
      !callback.search &&
      !callback.hash
    );
  } catch {
    return false;
  }
}

/** Read-only facts from the selected tenant. No live provider probe, token opening,
 * refresh, seed, mutation, or "complete setup" flag is performed here. */
export async function readCompanySetup() {
  const env = workspaceEnvironment();
  const outlookConfigured = !!getOutlookConfig(env);
  const filesConfig = getMicrosoftFilesConfig(env);
  const [
    settings,
    warehouseCounts,
    binCounts,
    productCounts,
    aliasCounts,
    savedOutlook,
    savedFiles,
    savedQuickbooks,
  ] = await Promise.all([
    savedConfiguration(),
    db.select({ total: count() }).from(warehousesTable),
    db
      .select({ total: countDistinct(warehouseBinsTable.warehouseId) })
      .from(warehouseBinsTable),
    db
      .select({ total: count() })
      .from(productsTable)
      .where(eq(productsTable.active, true)),
    db.select({ total: count() }).from(supplierProductAliasesTable),
    db
      .select({
        status: outlook.status,
        grantedScopes: outlook.grantedScopes,
        hasAuthorization: sql<boolean>`${outlook.accessToken} IS NOT NULL AND ${outlook.refreshToken} IS NOT NULL`,
        hasCalendar: sql<boolean>`${outlook.calendarId} IS NOT NULL`,
      })
      .from(outlook)
      .where(eq(outlook.id, 1))
      .limit(1),
    db
      .select({
        status: files.status,
        grantedScopes: files.grantedScopes,
        matchesApp: filesConfig
          ? sql<boolean>`${files.clientId} = ${filesConfig.clientId}`
          : sql<boolean>`false`,
        hasAuthorization: sql<boolean>`${files.accessToken} IS NOT NULL AND ${files.refreshToken} IS NOT NULL`,
        verifiedTargetSaved: sql<boolean>`${files.driveId} IS NOT NULL AND ${files.folderId} IS NOT NULL AND ${files.verifiedAt} IS NOT NULL`,
      })
      .from(files)
      .where(eq(files.id, 1))
      .limit(1),
    db
      .select({
        status: quickbooks.status,
        environment: quickbooks.environment,
        readinessStatus: quickbooks.readinessStatus,
        grantedScopes: quickbooks.grantedScopes,
        refreshTokenExpiresAt: quickbooks.refreshTokenExpiresAt,
        hasAuthorization: sql<boolean>`length(${quickbooks.encryptedAccessToken}) > 0 AND length(${quickbooks.encryptedRefreshToken}) > 0`,
      })
      .from(quickbooks)
      .limit(1),
  ]);
  const o = savedOutlook[0],
    f = savedFiles[0],
    q = savedQuickbooks[0];
  const email = emailDeliveryCapability(env),
    sms = smsDeliveryCapability(env);
  const oConnected = o?.status === "connected" && o.hasAuthorization === true;
  const fConnected =
    f?.status === "connected" &&
    f.matchesApp === true &&
    f.hasAuthorization === true &&
    hasSelectedFilesScope(f.grantedScopes);
  return companySetupReadiness({
    settings,
    warehouses: warehouseCounts[0]?.total ?? 0,
    warehousesWithBins: binCounts[0]?.total ?? 0,
    activeProducts: productCounts[0]?.total ?? 0,
    supplierAliases: aliasCounts[0]?.total ?? 0,
    outlook: {
      configured: outlookConfigured,
      savedConnection: oConnected,
      calendarSelected:
        oConnected &&
        o.hasCalendar === true &&
        savedOutlookCalendarScope(o.grantedScopes),
      mailboxAuthorized: oConnected && hasOutlookMailScope(o.grantedScopes),
    },
    files: {
      configured: !!filesConfig,
      savedConnection: fConnected,
      verifiedTargetSaved: fConnected && f.verifiedTargetSaved === true,
    },
    quickbooks: {
      configured: quickBooksSetupConfigured(env),
      savedConnection: savedAccountingGrant(q, env.QUICKBOOKS_ENVIRONMENT),
      environment:
        q?.environment === "sandbox" || q?.environment === "production"
          ? q.environment
          : null,
      revocationPending: [
        "revocation_pending",
        "revocation_unknown",
        "revocation_failed",
      ].includes(q?.readinessStatus ?? ""),
    },
    email: { configured: email.configured, mode: email.mode },
    sms: { configured: sms.serverSendAvailable, mode: sms.mode },
  });
}
