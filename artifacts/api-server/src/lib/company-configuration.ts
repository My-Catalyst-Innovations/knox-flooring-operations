import { z } from "zod";
import { DomainError } from "./operations-rules";

export const companyConfigurationVersion = 1 as const;
export const standardRateCategories = [
  "Luxury Vinyl Plank (LVP)",
  "Luxury Vinyl Tile (LVT)",
  "Hardwood",
  "Carpet",
  "Tile",
  "Laminate",
  "Waterproof Flooring",
  "Commercial Carpet Tile",
  "Commercial LVT",
] as const;
const text = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .refine(
      (value) => !/[\p{Cc}]/u.test(value),
      "Use single-line company settings.",
    )
    .refine(
      (value) =>
        !/(?:\bBearer\s|\b(?:sk|rk)_(?:live|test)_|postgres(?:ql)?:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY)/i.test(
          value,
        ),
      "Remove credentials from company settings.",
    );
const amount = z.number().finite().min(0).max(10_000_000);
// A string-keyed record with an explicit key check stays sparse in both Zod 3
// and Zod 4; enum-keyed records in newer Zod versions require every enum member.
const rates = z
  .record(z.string(), amount.nullable())
  .refine((value) =>
    Object.keys(value).every((key) =>
      standardRateCategories.includes(
        key as (typeof standardRateCategories)[number],
      ),
    ),
  );
const companyConfigurationSchema = z
  .object({
    company: z
      .object({
        name: text(200),
        address: text(500),
        phone: text(50).refine(
          (value) => !value || /^[+()\d .-]+$/.test(value),
        ),
        email: z.union([z.literal(""), z.string().email().max(254)]),
        website: z
          .string()
          .max(500)
          .refine((value) => {
            if (!value) return true;
            try {
              const url = new URL(value);
              return (
                ["https:", "http:"].includes(url.protocol) &&
                !url.username &&
                !url.password &&
                !url.search &&
                !url.hash
              );
            } catch {
              return false;
            }
          }),
      })
      .strict(),
    branding: z
      .object({ accentColor: z.string().regex(/^#[a-f0-9]{6}$/i) })
      .strict(),
    workflow: z
      .object({
        leadStages: z
          .array(text(80).refine((value) => value.length > 0))
          .max(30)
          .refine(
            (values) =>
              new Set(values.map((value) => value.toLowerCase())).size ===
              values.length,
          ),
        closeout: z
          .object({
            requireReceivedMaterials: z.boolean(),
            requiredCompletionChecks: z
              .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,80}$/))
              .max(30),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    estimates: z
      .object({
        defaultWasteFactor: z.number().finite().min(0).max(100),
        legacyLaborRates: z
          .object({
            lvp: amount,
            hardwood: amount,
            carpet: amount,
            tile: amount,
          })
          .strict(),
        pricingPolicy: z
          .object({
            version: z.number().int().positive(),
            reviewed: z.boolean(),
            targetMarginPercent: z.number().finite().min(0).lt(100),
            laborRates: rates,
            productivitySqFtPerHour: rates.refine((value) =>
              Object.values(value).every((rate) => rate === null || rate > 0),
            ),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    commissions: z
      .object({
        basis: z.enum(["Revenue", "Gross Profit"]),
        defaultRate: z.number().finite().min(0).max(100),
      })
      .strict(),
  })
  .strict();
export type CompanyConfiguration = z.infer<typeof companyConfigurationSchema>;
export function savedOutlookCalendarScope(scope: string | null | undefined) {
  return (scope ?? "")
    .split(/\s+/)
    .some((value) =>
      ["calendars.readwrite", "calendars.readwrite.shared"].includes(
        value.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase(),
      ),
    );
}
export function savedAccountingGrant(
  connection:
    | {
        status: string;
        environment: string;
        grantedScopes: string[];
        refreshTokenExpiresAt: string;
        hasAuthorization: boolean;
      }
    | undefined,
  expectedEnvironment: string | undefined,
  now = Date.now(),
) {
  return (
    !!connection &&
    connection.status === "connected" &&
    ["sandbox", "production"].includes(connection.environment) &&
    connection.environment === expectedEnvironment &&
    connection.grantedScopes.includes("com.intuit.quickbooks.accounting") &&
    connection.hasAuthorization === true &&
    Date.parse(connection.refreshTokenExpiresAt) > now
  );
}
type Values = Record<string, unknown>;
const record = (value: unknown): value is Values =>
  !!value && typeof value === "object" && !Array.isArray(value);
function selectedRates(value: unknown) {
  if (!record(value)) return value;
  return Object.fromEntries(
    standardRateCategories
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );
}
function selectedPolicy(value: unknown) {
  if (value === null || value === undefined) return null;
  if (!record(value)) return value;
  return {
    version: value.version,
    reviewed: value.reviewed ?? false,
    targetMarginPercent: value.targetMarginPercent,
    laborRates: selectedRates(value.laborRates),
    productivitySqFtPerHour: selectedRates(value.productivitySqFtPerHour ?? {}),
  };
}

/** Whitelist construction, never row spread/serialization. No owner fields,
 * provider references, branding URLs, records or environment values are copied. */
export function portableCompanyConfiguration(
  settings: Values,
): CompanyConfiguration {
  const transition = settings.transitionPolicy;
  const value = {
    company: {
      name: settings.companyName,
      address: settings.address,
      phone: settings.phone,
      email: settings.email,
      website: settings.website,
    },
    branding: { accentColor: settings.customerAccentColor },
    workflow: {
      leadStages: settings.leadStages,
      closeout:
        transition === null || transition === undefined
          ? null
          : record(transition)
            ? {
                requireReceivedMaterials:
                  transition.requireReceivedMaterials ?? false,
                requiredCompletionChecks:
                  transition.requiredCompletionChecks ?? [],
              }
            : transition,
    },
    estimates: {
      defaultWasteFactor: settings.defaultWasteFactor,
      legacyLaborRates: {
        lvp: settings.defaultLaborRateLVP,
        hardwood: settings.defaultLaborRateHardwood,
        carpet: settings.defaultLaborRateCarpet,
        tile: settings.defaultLaborRateTile,
      },
      pricingPolicy: selectedPolicy(settings.estimatePolicy),
    },
    commissions: {
      basis: settings.commissionBasis,
      defaultRate: settings.defaultCommissionRate,
    },
  };
  const parsed = companyConfigurationSchema.safeParse(value);
  if (!parsed.success)
    throw new DomainError(
      409,
      "Review unsupported or invalid company settings before exporting. No configuration file was generated.",
    );
  return parsed.data;
}

export function companyConfigurationExport(settings: Values, now = new Date()) {
  const configuration = portableCompanyConfiguration(settings);
  const rawPolicy = record(settings.estimatePolicy)
    ? settings.estimatePolicy
    : {};
  const customRates = [
    rawPolicy.laborRates,
    rawPolicy.productivitySqFtPerHour,
  ].some(
    (value) =>
      record(value) &&
      Object.keys(value).some(
        (key) =>
          !standardRateCategories.includes(
            key as (typeof standardRateCategories)[number],
          ),
      ),
  );
  return {
    format: "catalyst-works-company-configuration" as const,
    schemaVersion: companyConfigurationVersion,
    exportedAt: now.toISOString(),
    configuration,
    omissions: [
      "Business records, inventory, transactions, users and invitations",
      "Connections, provider IDs and mappings, credentials, tokens and secrets",
      "Logo files and private or external branding URLs",
      ...(customRates
        ? [
            "Custom estimate rate categories are outside version 1; review them separately.",
          ]
        : []),
    ],
    restoreSupported: false,
  };
}

export type SetupState =
  | "complete"
  | "missing"
  | "needs_review"
  | "acceptance_pending";
export type SetupStep = {
  key: string;
  title: string;
  state: SetupState;
  detail: string;
  href: string;
};
export type CompanySetupFacts = {
  settings: Values | null;
  warehouses: number;
  warehousesWithBins: number;
  activeProducts: number;
  supplierAliases: number;
  outlook: {
    configured: boolean;
    savedConnection: boolean;
    calendarSelected: boolean;
    mailboxAuthorized: boolean;
  };
  files: {
    configured: boolean;
    savedConnection: boolean;
    verifiedTargetSaved: boolean;
  };
  quickbooks: {
    configured: boolean;
    savedConnection: boolean;
    environment: "sandbox" | "production" | null;
    revocationPending: boolean;
  };
  email: { configured: boolean; mode: "capture" | "allowlist" | "live" };
  sms: { configured: boolean; mode: "capture" | "allowlist" | "live" };
};
export function companySetupReadiness(
  facts: CompanySetupFacts,
  now = new Date(),
) {
  let configuration: CompanyConfiguration | null = null;
  let invalidSettings = false;
  if (facts.settings) {
    try {
      configuration = portableCompanyConfiguration(facts.settings);
    } catch {
      invalidSettings = true;
    }
  }
  const steps: SetupStep[] = [];
  const step = (
    key: string,
    title: string,
    done: boolean,
    detail: string,
    href = "/settings",
  ) =>
    steps.push({
      key,
      title,
      state: done ? "complete" : "missing",
      detail,
      href,
    });
  step(
    "company_profile",
    "Saved company identity",
    !!configuration?.company.name &&
      Boolean(configuration.company.email || configuration.company.phone),
    "Requires a saved business name and contact. Presence of settings does not establish client acceptance.",
  );
  const policy = configuration?.estimates.pricingPolicy;
  step(
    "pricing_policy",
    "Owner-reviewed estimate pricing",
    !!policy?.reviewed &&
      Object.values(policy.laborRates).some(
        (value) => value !== null && value >= 0,
      ),
    "Requires a saved reviewed policy and a supported rate, including an explicit zero. Missing and null rates remain unconfigured; client prices still need verification.",
  );
  step(
    "closeout_policy",
    "Saved installation and closeout policy",
    !!configuration?.workflow.closeout,
    "Uses the saved policy, including an explicitly saved empty checklist. No policy is inferred.",
  );
  if (invalidSettings)
    for (const item of steps) {
      item.state = "needs_review";
      item.detail = "Review invalid or unsupported saved company settings.";
    }
  step(
    "warehouse_bins",
    "Warehouses have bin locations",
    facts.warehouses > 0 && facts.warehousesWithBins === facts.warehouses,
    String(facts.warehouses) +
      " saved warehouses; " +
      String(facts.warehousesWithBins) +
      " have bins. Confirm all required locations with the company.",
    "/inventory",
  );
  steps.push({
    key: "catalog_acceptance",
    title: "Inventory and supplier data acceptance",
    state: "acceptance_pending",
    detail:
      String(facts.activeProducts) +
      " active products and " +
      String(facts.supplierAliases) +
      " saved aliases. Counts can include marked test data; actual stock, units and negotiated prices are not accepted by this checklist.",
    href: "/inventory",
  });
  step(
    "outlook_server",
    "Outlook server configuration",
    facts.outlook.configured,
    "Validated company server configuration; separate from account consent.",
  );
  step(
    "outlook_connection",
    "Saved Outlook calendar authorization",
    facts.outlook.configured &&
      facts.outlook.savedConnection &&
      facts.outlook.calendarSelected,
    "Requires saved authorization and a calendar selection. This does not probe Microsoft or accept calendar synchronization.",
  );
  step(
    "outlook_mailbox",
    "Saved Outlook mailbox authorization",
    facts.outlook.configured &&
      facts.outlook.savedConnection &&
      facts.outlook.mailboxAuthorized,
    "Requires saved Mail.Send permission. This is independent of the Resend system-email service and does not prove recipient delivery.",
  );
  step(
    "files_server",
    "Microsoft Files server configuration",
    facts.files.configured,
    "Validated company Files app configuration; folder consent remains separate.",
  );
  step(
    "files_connection",
    "Saved Microsoft Files authorization and target",
    facts.files.configured &&
      facts.files.savedConnection &&
      facts.files.verifiedTargetSaved,
    "Requires saved selected-files authorization and a previously verified target. Current folder access must still be accepted.",
  );
  step(
    "quickbooks_server",
    "QuickBooks server configuration",
    facts.quickbooks.configured,
    "Requires valid company app settings and callback; no company connection is inferred.",
  );
  step(
    "quickbooks_connection",
    "Saved QuickBooks company authorization",
    facts.quickbooks.configured &&
      facts.quickbooks.savedConnection &&
      !facts.quickbooks.revocationPending,
    facts.quickbooks.revocationPending
      ? "Finish the pending grant revocation before reconnecting."
      : "Requires saved Accounting scope, matching configured environment and unexpired authorization. Actual mappings, Projects eligibility and financial acceptance remain separate.",
  );
  step(
    "email_delivery",
    "Company/system email service",
    facts.email.configured && facts.email.mode !== "capture",
    !facts.email.configured
      ? "The Resend system-email sender is not configured. Outlook mailbox authorization is shown separately."
      : facts.email.mode === "capture"
        ? "Resend system email is captured. Outlook mailbox authorization is shown separately."
        : "Saved Resend system-email configuration uses " +
          facts.email.mode +
          " mode. Allowlist mode still limits recipients.",
  );
  step(
    "sms_delivery",
    "Configured company SMS",
    facts.sms.configured && facts.sms.mode !== "capture",
    !facts.sms.configured
      ? "Company SMS is not enabled for a permitted server send. Review the provider, sender and recipient policy; device sharing remains separate."
      : facts.sms.mode === "capture"
        ? "Company SMS is captured or unavailable; device sharing remains separate."
        : "Saved SMS configuration uses " +
          facts.sms.mode +
          " mode. A permitted sender and real delivery/reply acceptance are still required.",
  );
  steps.push({
    key: "provider_acceptance",
    title: "End-to-end provider acceptance",
    state: "acceptance_pending",
    detail:
      "This checklist reads saved configuration only. It does not send email or texts, post accounting records, create calendar events or copy files. Provider acceptance is not recorded as complete.",
    href: "/settings",
  });
  return {
    schemaVersion: 1 as const,
    checkedAt: now.toISOString(),
    source: "persisted_company_settings" as const,
    setupStepsCompleted: steps.filter((item) => item.state === "complete")
      .length,
    setupStepCount: steps.length,
    clientProductionAcceptanceComplete: false,
    privateOnboarding: true,
    configurationExportAvailable: !!configuration,
    quickbooksEnvironment: facts.quickbooks.environment,
    steps,
  };
}
