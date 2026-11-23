import { describe, expect, it } from "vitest";
import {
  companyConfigurationExport,
  companySetupReadiness,
  savedAccountingGrant,
  savedOutlookCalendarScope,
  type CompanySetupFacts,
} from "./company-configuration";

export const savedSettings = () => ({
  companyName: "Juniper Business",
  address: "100 Business Way",
  phone: "+18655550100",
  email: "office@juniper.example",
  website: "https://juniper.example",
  customerAccentColor: "#315e75",
  leadStages: ["New", "Measured", "Quoted"],
  defaultWasteFactor: 10,
  defaultLaborRateLVP: 2.25,
  defaultLaborRateHardwood: 4,
  defaultLaborRateCarpet: 1.5,
  defaultLaborRateTile: 5,
  commissionBasis: "Gross Profit",
  defaultCommissionRate: 5,
  estimatePolicy: {
    version: 2,
    reviewed: true,
    targetMarginPercent: 35,
    laborRates: { Carpet: 1.5, Hardwood: null },
    productivitySqFtPerHour: { Carpet: 80 },
  },
  transitionPolicy: {
    requireReceivedMaterials: true,
    requiredCompletionChecks: ["cleanup", "customerSignoff"],
  },
});
const facts = (): CompanySetupFacts => ({
  settings: savedSettings(),
  warehouses: 2,
  warehousesWithBins: 2,
  activeProducts: 15,
  supplierAliases: 15,
  outlook: {
    configured: true,
    savedConnection: true,
    calendarSelected: true,
    mailboxAuthorized: true,
  },
  files: { configured: true, savedConnection: true, verifiedTargetSaved: true },
  quickbooks: {
    configured: true,
    savedConnection: true,
    environment: "sandbox",
    revocationPending: false,
  },
  email: { configured: true, mode: "allowlist" },
  sms: { configured: true, mode: "capture" },
});
describe("versioned company configuration boundary", () => {
  it("exports only the supported portable settings and preserves actual rates", () => {
    const result = companyConfigurationExport(
      savedSettings(),
      new Date("2026-11-23T00:00:00Z"),
    );
    expect(Object.keys(result).sort()).toEqual([
      "configuration",
      "exportedAt",
      "format",
      "omissions",
      "restoreSupported",
      "schemaVersion",
    ]);
    expect(result).toMatchObject({
      format: "catalyst-works-company-configuration",
      schemaVersion: 1,
      restoreSupported: false,
      configuration: {
        company: { name: "Juniper Business" },
        branding: { accentColor: "#315e75" },
        estimates: {
          pricingPolicy: {
            reviewed: true,
            laborRates: { Carpet: 1.5, Hardwood: null },
          },
        },
      },
    });
    expect(Object.keys(result.configuration).sort()).toEqual([
      "branding",
      "commissions",
      "company",
      "estimates",
      "workflow",
    ]);
  });
  it("cannot serialize users, personal records, financial data, secrets or provider IDs added to a settings row", () => {
    const settings = {
      ...savedSettings(),
      ownerName: "PRIVATE_OWNER_MARKER",
      ownerRole: "PRIVATE_ROLE_MARKER",
      googleCalendarSyncToken: "GOOGLE_SECRET_MARKER",
      companyLogoUrl: "https://blob.example/private?sig=PRIVATE_SAS_MARKER",
      accessToken: "TOKEN_MARKER",
      databaseUrl: "DATABASE_MARKER",
      stripeCustomerId: "STRIPE_MARKER",
      jobs: [{ name: "JOB_MARKER" }],
      customers: ["CUSTOMER_MARKER"],
      suppliers: ["VENDOR_MARKER"],
      inventory: ["STOCK_MARKER"],
      invoices: ["INVOICE_MARKER"],
      users: ["USER_MARKER"],
      providerMappings: ["MAPPING_MARKER"],
      estimatePolicy: {
        ...savedSettings().estimatePolicy,
        clientId: "CLIENT_MARKER",
        accessToken: "NESTED_SECRET_MARKER",
      },
      transitionPolicy: {
        ...savedSettings().transitionPolicy,
        employees: ["EMPLOYEE_MARKER"],
      },
    };
    const serialized = JSON.stringify(companyConfigurationExport(settings));
    for (const marker of [
      "PRIVATE_",
      "GOOGLE_",
      "TOKEN_MARKER",
      "DATABASE_",
      "STRIPE_",
      "JOB_",
      "CUSTOMER_",
      "VENDOR_",
      "STOCK_",
      "INVOICE_",
      "USER_",
      "MAPPING_",
      "CLIENT_",
      "NESTED_",
      "EMPLOYEE_",
    ])
      expect(serialized).not.toContain(marker);
    expect(serialized).not.toMatch(
      /ownerName|ownerRole|googleCalendar|companyLogoUrl|accessToken|databaseUrl|providerMappings/,
    );
  });
  it("omits unsupported custom rate keys without exposing their names", () => {
    const settings = savedSettings();
    Object.assign(settings.estimatePolicy.laborRates, {
      "private-person@example.test": 700,
    });
    const result = companyConfigurationExport(settings);
    expect(JSON.stringify(result)).not.toContain("private-person");
    expect(result.omissions).toContain(
      "Custom estimate rate categories are outside version 1; review them separately.",
    );
  });
  it("rejects embedded credentials, unsafe website credentials/query and malformed numeric policy values", () => {
    for (const settings of [
      { ...savedSettings(), companyName: "Bearer SECRET_CREDENTIAL" },
      {
        ...savedSettings(),
        website: "https://business.example/?access_token=secret",
      },
      { ...savedSettings(), website: "https://user:password@business.example" },
      {
        ...savedSettings(),
        estimatePolicy: {
          ...savedSettings().estimatePolicy,
          laborRates: { Carpet: { token: "secret" } },
        },
      },
      { ...savedSettings(), defaultCommissionRate: Number.NaN },
    ])
      expect(() => companyConfigurationExport(settings)).toThrow(
        /Review unsupported/,
      );
  });
});
describe("persisted setup facts and acceptance honesty", () => {
  it("supports sparse standard pricing dictionaries and distinguishes intentional reviewed zero from null or missing", () => {
    const settings = {
      ...savedSettings(),
      estimatePolicy: {
        version: 3,
        reviewed: true,
        targetMarginPercent: 35,
        laborRates: { Carpet: 0 },
        productivitySqFtPerHour: {},
      },
    };
    const exported = companyConfigurationExport(settings);
    expect(exported.configuration.estimates.pricingPolicy?.laborRates).toEqual({
      Carpet: 0,
    });
    expect(
      exported.configuration.estimates.pricingPolicy?.productivitySqFtPerHour,
    ).toEqual({});
    const value = facts();
    value.settings = settings;
    expect(
      companySetupReadiness(value).steps.find(
        (step) => step.key === "pricing_policy",
      )?.state,
    ).toBe("complete");
    for (const laborRates of [{ Carpet: null }, {}]) {
      value.settings = {
        ...settings,
        estimatePolicy: { ...settings.estimatePolicy, laborRates },
      };
      expect(
        companySetupReadiness(value).steps.find(
          (step) => step.key === "pricing_policy",
        )?.state,
      ).toBe("missing");
    }
  });
  it("keeps Outlook mailbox authorization independent from the Resend system-email service and calendar", () => {
    const value = facts();
    value.outlook.calendarSelected = false;
    value.email.configured = false;
    const result = companySetupReadiness(value);
    expect(
      result.steps.find((step) => step.key === "outlook_mailbox")?.state,
    ).toBe("complete");
    expect(
      result.steps.find((step) => step.key === "outlook_connection")?.state,
    ).toBe("missing");
    expect(
      result.steps.find((step) => step.key === "email_delivery"),
    ).toMatchObject({
      title: "Company/system email service",
      state: "missing",
    });
    expect(
      result.steps.find((step) => step.key === "email_delivery")?.detail,
    ).toContain("Outlook mailbox authorization is shown separately");
  });
  it("shows saved policies and actual bins but never infers client or provider acceptance", () => {
    const result = companySetupReadiness(facts());
    expect(
      result.steps.find((step) => step.key === "pricing_policy")?.state,
    ).toBe("complete");
    expect(
      result.steps.find((step) => step.key === "warehouse_bins")?.state,
    ).toBe("complete");
    expect(
      result.steps.find((step) => step.key === "quickbooks_connection")?.state,
    ).toBe("complete");
    expect(
      result.steps.find((step) => step.key === "provider_acceptance")?.state,
    ).toBe("acceptance_pending");
    expect(
      result.steps.find((step) => step.key === "catalog_acceptance")?.state,
    ).toBe("acceptance_pending");
    expect(result.clientProductionAcceptanceComplete).toBe(false);
  });
  it("does not turn raw server credentials or a marked catalog count into a saved company connection", () => {
    const value = facts();
    value.quickbooks.savedConnection = false;
    value.files.savedConnection = false;
    value.outlook.calendarSelected = false;
    const result = companySetupReadiness(value);
    for (const key of [
      "quickbooks_connection",
      "files_connection",
      "outlook_connection",
    ])
      expect(result.steps.find((step) => step.key === key)?.state).toBe(
        "missing",
      );
    expect(
      result.steps.find((step) => step.key === "catalog_acceptance")?.detail,
    ).toContain("15 active products");
  });
  it("requires a genuinely reviewed priced policy, every configured warehouse's bin, and resolved grant revocation", () => {
    const value = facts();
    (value.settings!.estimatePolicy as Record<string, unknown>).reviewed =
      false;
    value.warehousesWithBins = 1;
    value.quickbooks.revocationPending = true;
    const result = companySetupReadiness(value);
    for (const key of [
      "pricing_policy",
      "warehouse_bins",
      "quickbooks_connection",
    ])
      expect(result.steps.find((step) => step.key === key)?.state).toBe(
        "missing",
      );
  });
  it("keeps capture-only communications incomplete and marks invalid settings for review", () => {
    const value = facts();
    value.email.mode = "capture";
    value.settings!.customerAccentColor = "not-a-color";
    const result = companySetupReadiness(value);
    expect(result.configurationExportAvailable).toBe(false);
    for (const key of ["company_profile", "pricing_policy", "closeout_policy"])
      expect(result.steps.find((step) => step.key === key)?.state).toBe(
        "needs_review",
      );
    for (const key of ["email_delivery", "sms_delivery"])
      expect(result.steps.find((step) => step.key === key)?.state).toBe(
        "missing",
      );
  });
  it("treats absence of persisted settings as missing without creating defaults", () => {
    const value = facts();
    value.settings = null;
    const result = companySetupReadiness(value);
    expect(result.configurationExportAvailable).toBe(false);
    expect(
      result.steps.find((step) => step.key === "company_profile")?.state,
    ).toBe("missing");
  });
});

describe("saved Accounting authorization metadata", () => {
  it("requires a recorded calendar write grant independently of Mail.Send and supports Graph-prefixed scopes", () => {
    for (const scope of [
      "Calendars.ReadWrite",
      "offline_access Calendars.ReadWrite.Shared Mail.Send",
      "https://graph.microsoft.com/Calendars.ReadWrite.Shared",
    ])
      expect(savedOutlookCalendarScope(scope)).toBe(true);
    for (const scope of [
      null,
      "",
      "Mail.Send",
      "Calendars.Read",
      "NotCalendars.ReadWrite",
    ])
      expect(savedOutlookCalendarScope(scope)).toBe(false);
  });
  it("requires the Accounting scope, selected environment, stored authorization and an unexpired refresh grant", () => {
    const now = Date.parse("2026-11-23T00:00:00Z");
    const connection = {
      status: "connected",
      environment: "sandbox",
      grantedScopes: ["com.intuit.quickbooks.accounting"],
      refreshTokenExpiresAt: "2027-01-01T00:00:00Z",
      hasAuthorization: true,
    };
    expect(savedAccountingGrant(connection, "sandbox", now)).toBe(true);
    expect(savedAccountingGrant(undefined, "sandbox", now)).toBe(false);
    for (const changed of [
      { ...connection, grantedScopes: [] },
      { ...connection, environment: "production" },
      { ...connection, status: "disconnected" },
      { ...connection, hasAuthorization: false },
      { ...connection, refreshTokenExpiresAt: "2026-11-22T00:00:00Z" },
      { ...connection, refreshTokenExpiresAt: "invalid" },
    ])
      expect(savedAccountingGrant(changed, "sandbox", now)).toBe(false);
  });
});
