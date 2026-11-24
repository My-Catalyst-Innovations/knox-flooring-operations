import { createHash } from "node:crypto";

export type PolicyKind = "privacy" | "terms";
type Section = { title: string; text: string };
export type PolicyDocument = {
  kind: PolicyKind;
  version: string;
  title: string;
  fields: readonly string[];
  sections: readonly Section[];
};
/** Internal drafts. No frontend imports or public route exposes these before approval. */
export const policyDrafts: Record<PolicyKind, PolicyDocument> = {
  privacy: {
    kind: "privacy",
    version: "2026-11-23.1",
    title: "Catalyst Works Privacy Policy",
    fields: [
      "legalEntity",
      "businessAddress",
      "privacyContact",
      "privacyRoles",
      "processorsAndLocations",
      "retentionAndDeletion",
      "backupRetention",
      "rightsAndRequests",
      "incidentCommunications",
      "policyChanges",
    ],
    sections: [
      {
        title: "Who operates Catalyst Works",
        text: "{{legalEntity}} operates Catalyst Works. Business address: {{businessAddress}}. Privacy contact: {{privacyContact}}. The respective privacy responsibilities of the platform and client companies are: {{privacyRoles}}.",
      },
      {
        title: "Information used by the product",
        text: "Works stores company and staff account information; password hashes and session/security records; customer and supplier contact information; products, SKU aliases and negotiated prices; warehouses, bins, physical inventory and stock movements; quotes, jobs, schedules, purchase orders, receiving records and invoices; time, expenses, photos and documents; import source files, decisions, approvals and audit history. These records support the company's operational workflows and retained source provenance.",
      },
      {
        title: "Optional connected services",
        text: "When enabled by an authorized company owner, Works uses delegated QuickBooks authorization and a connected company identifier for supported reviewed accounting and reconciliation. Optional Microsoft connections support approved mail, calendar and selected document folders. Other enabled messaging, storage, payment, measurement or AI features may process the information required for that feature. Actual providers, subprocessors, purposes, service locations and applicable transfer arrangements are: {{processorsAndLocations}}. This policy does not represent that every optional service is connected.",
      },
      {
        title: "Messages and device actions",
        text: "Company texts depend on configured delivery controls and recorded recipient preferences. Capture mode records a preview without sending a company text. Device sharing opens another device application and does not establish delivery or new recipient permission. Email and calendar provider acceptance is distinct from recipient delivery. Users should verify the destination and content before sharing.",
      },
      {
        title: "Access and security",
        text: "Workspace authentication and role permissions limit application access. Integration authorization tokens are protected separately from ordinary business records. Public customer links can disclose the job or quote information made available through that link; companies should share those links carefully. No system is represented as risk-free or certified by this draft.",
      },
      {
        title: "Retention, disconnect and deletion",
        text: "Disconnecting a provider stops local connector use and initiates supported grant revocation; the app distinguishes pending, unknown and confirmed outcomes. Disconnecting does not erase historical business records or source evidence. The reviewed retention and deletion process is: {{retentionAndDeletion}}. Backup retention and deletion limitations are: {{backupRetention}}. No automatic data-erasure capability or unapproved retention period is promised here.",
      },
      {
        title: "Requests and incident communications",
        text: "Privacy rights and request handling: {{rightsAndRequests}}. Incident communications: {{incidentCommunications}}. Policy changes: {{policyChanges}}.",
      },
    ],
  },
  terms: {
    kind: "terms",
    version: "2026-11-23.1",
    title: "Catalyst Works End User License Agreement",
    fields: [
      "legalEntity",
      "businessAddress",
      "contractContact",
      "authorizedUse",
      "feesAndBilling",
      "supportTerms",
      "terminationTerms",
      "liabilityAndWarranties",
      "lawAndDisputes",
      "agreementChanges",
    ],
    sections: [
      {
        title: "Parties and product",
        text: "This agreement concerns Catalyst Works, operated by {{legalEntity}}, at {{businessAddress}}. Contract inquiries: {{contractContact}}. Works provides company work management, inventory, purchasing, job documents, operational records and optional integrations. The authorized use and account responsibilities are: {{authorizedUse}}.",
      },
      {
        title: "Company records and review",
        text: "The company is responsible for the accuracy and authority of the records, imports and connected accounts it supplies. Supported imports and accounting actions have explicit review and approval boundaries; retained historical context does not itself create opening balances, stock movements or provider transactions. An available feature or sandbox test does not represent acceptance by Intuit or any other provider.",
      },
      {
        title: "Optional integrations",
        text: "A company owner chooses whether to connect supported services and must have authority to grant the requested access. A connection may require separate provider licensing, permissions or approval. Revocation, paused local use and confirmed provider revocation are distinct states. Provider delivery, account eligibility and external service availability are not inferred from local configuration.",
      },
      {
        title: "Fees and support",
        text: "Pricing, implementation services and support commitments are set out in the customer's signed order or private quote. No universal fee or support service level is advertised by this page. Reviewed fees and billing terms: {{feesAndBilling}}. Reviewed support terms: {{supportTerms}}.",
      },
      {
        title: "Termination and retained records",
        text: "Termination, access removal, data return and retained-record responsibilities: {{terminationTerms}}. Disconnecting an integration does not delete the company's business history or prove that a provider grant was revoked until that outcome is confirmed.",
      },
      {
        title: "Reviewed legal provisions",
        text: "Warranties, disclaimers and allocation of liability: {{liabilityAndWarranties}}. Governing law and dispute process: {{lawAndDisputes}}. Agreement changes: {{agreementChanges}}.",
      },
    ],
  },
};
export const policyFieldPrompts: Record<string, string> = {
  legalEntity:
    "Exact contracting/operator legal entity; owner/legal review required",
  businessAddress: "Approved public business/service address",
  privacyContact: "Approved privacy contact and channel; no invented address",
  contractContact: "Approved contract contact and channel",
  privacyRoles:
    "Reviewed platform/client privacy responsibilities for supported jurisdictions",
  processorsAndLocations:
    "Actual enabled processors/subprocessors, purposes, regions and transfer arrangements",
  retentionAndDeletion:
    "Actual record retention and operator deletion/request procedure; no automatic erasure promise",
  backupRetention:
    "Actual backup retention, restore handling and deletion limitations",
  rightsAndRequests:
    "Applicable rights, verification, request channels and actual response commitments",
  incidentCommunications:
    "Approved incident notice/contact process and applicable obligations",
  policyChanges: "Approved policy update/notification process",
  authorizedUse:
    "Reviewed license scope, account obligations and authorized use restrictions",
  feesAndBilling:
    "Approved private quote/order billing, renewal, tax and cancellation terms",
  supportTerms:
    "Actual support channel/hours and any contract-specific commitments; no invented SLA",
  terminationTerms:
    "Reviewed termination, export/return and retained-record terms",
  liabilityAndWarranties:
    "Counsel/owner-approved warranties, disclaimers and liability provisions",
  lawAndDisputes:
    "Reviewed governing law and dispute procedure; no assumed jurisdiction",
  agreementChanges: "Approved agreement-change process",
};
const placeholder =
  /\b(?:TODO|TBD|UNKNOWN|REPLACE|UNAPPROVED)\b|\{\{|\}\}|\[\[|\]\]/i;
export function candidatePolicy(kind: PolicyKind, input: unknown) {
  const draft = policyDrafts[kind];
  const fields =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const unresolved = draft.fields.filter(
    (key) =>
      typeof fields[key] !== "string" ||
      !(fields[key] as string).trim() ||
      (fields[key] as string).length > 6000 ||
      placeholder.test(fields[key] as string) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
        fields[key] as string,
      ),
  );
  const replace = (text: string) =>
    text.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
      unresolved.includes(key)
        ? `[OPERATOR REVIEW REQUIRED: ${key}]`
        : (fields[key] as string).trim(),
    );
  const sections = draft.sections.map((section) => ({
    title: section.title,
    text: replace(section.text),
  }));
  const body =
    [
      draft.title,
      `Version ${draft.version}`,
      ...sections.flatMap((section) => [section.title, section.text]),
    ].join("\n\n") + "\n";
  return {
    kind,
    version: draft.version,
    title: draft.title,
    sections,
    body,
    contentSha256: createHash("sha256").update(body, "utf8").digest("hex"),
    unresolved,
  };
}
/** Only deployment configuration can approve publication. Never read DB settings, request data or tenant environment overrides. */
export function publishedPolicy(
  kind: PolicyKind,
  raw: string | undefined,
  at = Date.now(),
) {
  try {
    if (!raw || Buffer.byteLength(raw) > 100_000) return null;
    const config = JSON.parse(raw);
    if (
      !config ||
      config.publicationVersion !== 1 ||
      !config.documents ||
      typeof config.documents !== "object"
    )
      return null;
    const approval = config.documents[kind];
    if (
      !approval ||
      approval.approved !== true ||
      approval.version !== policyDrafts[kind].version ||
      typeof approval.approvedBy !== "string" ||
      approval.approvedBy.trim().length < 3 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
        approval.approvedAt,
      ) ||
      !Number.isFinite(Date.parse(approval.approvedAt)) ||
      Date.parse(approval.approvedAt) > at
    )
      return null;
    const timestamp = /^(.*?)(?:\.(\d{1,3}))?Z$/.exec(approval.approvedAt)!;
    if (
      new Date(approval.approvedAt).toISOString() !==
      `${timestamp[1]}.${(timestamp[2] ?? "").padEnd(3, "0")}Z`
    )
      return null;
    const candidate = candidatePolicy(kind, config.fields);
    if (
      candidate.unresolved.length ||
      approval.contentSha256 !== candidate.contentSha256
    )
      return null;
    return candidate;
  } catch {
    return null;
  }
}
export function policyReviewPacket(fields: unknown = {}) {
  return {
    status: "draft_for_operator_review_not_published",
    automaticErasureImplemented: false,
    publicationControl:
      "Deployment-only WORKS_LEGAL_PUBLICATION_JSON; no tenant-owner publication endpoint",
    dataFlowEvidence: [
      {
        purpose:
          "Company contacts, operations, purchasing and source provenance",
        files: [
          "lib/db/src/schema/operations.ts",
          "lib/db/src/schema/supplier-imports.ts",
          "lib/db/src/schema/open-po-imports.ts",
          "artifacts/api-server/src/lib/legacy-history.ts",
        ],
        activation:
          "Normal authenticated company workflows; no opening balances or stock inferred by contact/PO/archive import",
      },
      {
        purpose:
          "QuickBooks delegated authorization, reviewed accounting and revocation history",
        files: [
          "artifacts/api-server/src/lib/quickbooks.ts",
          "artifacts/api-server/src/routes/quickbooks.ts",
          "artifacts/api-server/src/lib/quickbooks-worker.ts",
        ],
        activation:
          "Owner connection and configured features; accounting scope is existing, premium Projects requires separately verified access",
      },
      {
        purpose:
          "Optional Microsoft mail/calendar and selected document folder access",
        files: [
          "artifacts/api-server/src/lib/outlook-calendar.ts",
          "artifacts/api-server/src/lib/microsoft-files.ts",
        ],
        activation:
          "Separate owner consent and actual granted scopes/resource permissions; availability is not a claim every company has connected",
      },
      {
        purpose: "Private uploaded documents and retained originals",
        files: [
          "artifacts/api-server/src/lib/file-store.ts",
          "artifacts/api-server/src/routes/storage.ts",
        ],
        activation:
          "Configured private storage; request access depends on authenticated record authorization",
      },
      {
        purpose:
          "Email, company texts, capture previews and recipient preference evidence",
        files: [
          "artifacts/api-server/src/lib/comms.ts",
          "artifacts/api-server/src/lib/sms-preferences.ts",
          "artifacts/api-server/src/routes/communications.ts",
        ],
        activation:
          "Configured provider/delivery mode; live SMS requires recipient permission; device handoff does not prove delivery",
      },
      {
        purpose:
          "Fees, support, retention, privacy roles and processor arrangements",
        files: [],
        activation:
          "Operator review required; no universal fee/SLA, fixed retention period, signed provider contract or legal compliance is inferred from source",
      },
    ],
    requiredFields: policyFieldPrompts,
    documents: {
      privacy: candidatePolicy("privacy", fields),
      terms: candidatePolicy("terms", fields),
    },
    approvalsRequired: [
      "Actual legal entity and public contacts",
      "Complete wording reviewed by the responsible operator and qualified legal reviewer as appropriate",
      "Actual processors/locations and retained-record/backup practices",
      "Actual fees, support and jurisdiction terms",
      "Exact complete document versions and content SHA-256",
      "Deployment configuration approval; no app assessment or legal acceptance is performed by this tool",
    ],
    sources: [
      "https://static.developer.intuit.com/output_html/qbo/docs/go-live/publish-app.html",
      "https://static.developer.intuit.com/output_html/qbo/docs/go-live/publish-app/security-requirements.html",
    ],
  };
}
