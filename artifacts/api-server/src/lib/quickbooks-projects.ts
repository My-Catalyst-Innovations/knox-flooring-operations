import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  auditEventsTable,
  db,
  jobsTable,
  quickbooksConnectionsTable,
  quickbooksEntityMappingsTable,
  quickbooksProjectLinksTable as links,
  quickbooksProjectReviewsTable as reviews,
} from "@workspace/db";
import { workspaceEnvironment } from "@workspace/db/workspace";
import { DomainError } from "./operations-rules";
import {
  getConnection,
  projectsScope,
  qboProjectsGraph,
  qboRequest,
} from "./quickbooks";
import {
  createProjectMutation,
  getOwnedProject,
  graphData,
  listCustomerProjects,
  parseProject,
  projectsPreferenceEnabled,
  projectsQuery,
  QuickBooksProjectsError,
  usableProject,
  type QboProject,
  type ProjectsGraph,
} from "./quickbooks-projects-graph";

type Connection = NonNullable<Awaited<ReturnType<typeof getConnection>>>;
type Review = typeof reviews.$inferSelect;
type Link = typeof links.$inferSelect;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const conflict = (message: string): never => {
  throw new DomainError(409, message);
};
const publicCompany = (c: Connection | null) =>
  c
    ? {
        id: c.id,
        realmId: c.realmId,
        environment: c.environment,
        companyName: c.companyName,
      }
    : null;
const graphFor =
  (c: Connection): ProjectsGraph =>
  (operation, query, variables) =>
    qboProjectsGraph(operation, query, variables, c.id);
export function projectLinkDto(link: Link | null | undefined) {
  return link
    ? {
        kind: "qbo_project" as const,
        jobId: link.jobId,
        connectionId: link.connectionId,
        projectId: link.quickbooksProjectId,
        customerId: link.quickbooksCustomerId,
        projectName: link.projectName,
        projectStatus: link.projectStatus,
        revision: link.revision,
        approvedAt: link.approvedAt,
      }
    : null;
}
export function projectReviewDto(review: Review | null | undefined) {
  return review
    ? {
        id: review.id,
        jobId: review.jobId,
        connectionId: review.connectionId,
        revision: review.revision,
        fingerprint: review.fingerprint,
        status: review.status,
        name: review.name,
        description: review.description,
        lastError: review.lastError,
        submittedAt: review.submittedAt,
        quickbooksProjectId: review.quickbooksProjectId,
      }
    : null;
}

export async function projectsCapability(
  connection = undefined as Connection | null | undefined,
) {
  const c = connection === undefined ? await getConnection() : connection;
  const result = {
    connection: publicCompany(c),
    available: false,
    reason: null as string | null,
    scopeGranted: Boolean(c?.grantedScopes?.includes(projectsScope)),
    preferenceEnabled: false,
    probeSucceeded: false,
    requestScopeEnabled: Boolean(
      workspaceEnvironment().QUICKBOOKS_CLIENT_ID &&
      workspaceEnvironment().QUICKBOOKS_CLIENT_SECRET &&
      workspaceEnvironment().QUICKBOOKS_REDIRECT_URI,
    ),
  };
  if (c?.status !== "connected")
    return {
      ...result,
      reason: "Connect a QuickBooks company before using true Projects.",
    };
  if (!result.scopeGranted)
    return {
      ...result,
      reason:
        "Reconnect with the Projects permission. Intuit must enable this restricted scope for the app; existing subcustomers remain separate.",
    };
  try {
    result.preferenceEnabled = projectsPreferenceEnabled(
      await qboRequest("/preferences", {}, c.id),
    );
    if (!result.preferenceEnabled)
      return {
        ...result,
        reason:
          "Projects is not enabled in this connected company's preferences.",
      };
    const data = graphData(
      await graphFor(c)("query", projectsQuery, {
        first: 1,
        after: null,
        filter: {},
      }),
    );
    const page = data.projectManagementProjects as
      | { edges?: unknown; pageInfo?: { hasNextPage?: unknown } }
      | undefined;
    if (
      !Array.isArray(page?.edges) ||
      typeof page?.pageInfo?.hasNextPage !== "boolean"
    )
      throw new QuickBooksProjectsError(
        "Projects probe returned incomplete data.",
      );
    result.probeSucceeded = true;
    const current = await getConnection();
    if (
      current?.id !== c.id ||
      current.status !== "connected" ||
      !current.grantedScopes.includes(projectsScope)
    )
      return {
        ...result,
        reason:
          "The QuickBooks connection changed during the capability check.",
      };
    return { ...result, available: true };
  } catch {
    return {
      ...result,
      reason:
        "The connected company did not pass the Projects API capability check. Confirm Intuit app entitlement and company access; no upgrade has been purchased.",
    };
  }
}
async function requireCapability(c: Connection) {
  const capability = await projectsCapability(c);
  if (!capability.available) conflict(capability.reason!);
  return capability;
}
async function connectionFor(id: string) {
  const c = await getConnection();
  if (c?.status !== "connected" || c.id !== id)
    conflict("The QuickBooks connection changed. Refresh this company.");
  return c!;
}

async function jobContext(
  jobId: string,
  connectionId: string,
  capabilityRequired = true,
) {
  const c = await connectionFor(connectionId);
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!job) throw new DomainError(404, "Job not found.");
  const [mapping] = await db
    .select()
    .from(quickbooksEntityMappingsTable)
    .where(
      and(
        eq(quickbooksEntityMappingsTable.entityType, "customer"),
        eq(quickbooksEntityMappingsTable.localId, jobId),
      ),
    );
  if (
    !mapping ||
    mapping.status !== "linked" ||
    mapping.realmId !== c.realmId ||
    mapping.environment !== c.environment ||
    !/^\d{1,30}$/.test(mapping.quickbooksId)
  )
    conflict(
      "First verify and link this job's customer in the connected QuickBooks company.",
    );
  const customer = (
    await qboRequest(`/customer/${mapping!.quickbooksId}`, {}, c.id)
  ).Customer;
  if (
    customer?.Id !== mapping!.quickbooksId ||
    customer.Active === false ||
    customer.Job === true
  )
    conflict(
      "The linked QuickBooks customer is unavailable or is a legacy subcustomer. Verify the parent customer before using Projects.",
    );
  if (capabilityRequired) await requireCapability(c);
  return {
    c,
    job,
    mapping: mapping!,
    customer: {
      id: mapping!.quickbooksId,
      name: String(customer.DisplayName ?? job.customerName),
    },
  };
}
type Context = Awaited<ReturnType<typeof jobContext>>;
// All writers take the company lock before the job lock, matching connection replacement.
async function lockContext(tx: any, context: Context, revision: number) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(1959031411)`);
  const [c] = await tx
    .select()
    .from(quickbooksConnectionsTable)
    .where(eq(quickbooksConnectionsTable.id, context.c.id))
    .for("update");
  if (
    c?.status !== "connected" ||
    c.realmId !== context.c.realmId ||
    c.environment !== context.c.environment ||
    !c.grantedScopes?.includes(projectsScope)
  )
    conflict(
      "The QuickBooks company authorization changed. Refresh and review again.",
    );
  const [job] = await tx
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, context.job.id))
    .for("update");
  if (
    !job ||
    job.revision !== revision ||
    job.updatedAt !== context.job.updatedAt
  )
    conflict("The job changed. Refresh and review its Project again.");
  const [mapping] = await tx
    .select()
    .from(quickbooksEntityMappingsTable)
    .where(eq(quickbooksEntityMappingsTable.id, context.mapping.id))
    .for("update");
  if (
    mapping?.status !== "linked" ||
    mapping.quickbooksId !== context.customer.id ||
    mapping.realmId !== c.realmId ||
    mapping.environment !== c.environment
  )
    conflict(
      "The verified QuickBooks customer changed. Refresh and review again.",
    );
}
async function event(
  tx: any,
  userId: string,
  action: string,
  jobId: string,
  details: Record<string, unknown>,
) {
  await tx
    .insert(auditEventsTable)
    .values({
      id: randomUUID(),
      actorUserId: userId,
      action,
      entityType: "qbo_project",
      entityId: jobId,
      details,
      createdAt: now(),
    });
}
async function saveLink(
  tx: any,
  context: Context,
  project: QboProject,
  userId: string,
  note: string,
  expectedRevision?: number,
) {
  const occupants = await tx
    .select()
    .from(links)
    .where(
      and(
        eq(links.realmId, context.c.realmId),
        eq(links.environment, context.c.environment),
        eq(links.quickbooksProjectId, project.id),
      ),
    );
  if (occupants.some((row: Link) => row.jobId !== context.job.id))
    conflict(
      "This QuickBooks Project is already linked to another job in this company.",
    );
  const [existing] = await tx
    .select()
    .from(links)
    .where(eq(links.jobId, context.job.id))
    .for("update");
  if (existing && existing.revision !== expectedRevision)
    conflict(
      "The Project link changed. Refresh before approving another link.",
    );
  if (!existing && expectedRevision !== undefined)
    conflict("The Project link changed. Refresh before approving.");
  const timestamp = now();
  const fingerprint = hash([
    context.c.id,
    context.c.realmId,
    context.c.environment,
    project,
  ]);
  const values = {
    connectionId: context.c.id,
    realmId: context.c.realmId,
    environment: context.c.environment,
    quickbooksProjectId: project.id,
    quickbooksCustomerId: project.customerId,
    projectName: project.name,
    projectStatus: project.status,
    fingerprint,
    approvedBy: userId,
    approvedAt: timestamp,
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: timestamp,
  };
  const [saved] = existing
    ? await tx
        .update(links)
        .set(values)
        .where(eq(links.jobId, context.job.id))
        .returning()
    : await tx
        .insert(links)
        .values({ jobId: context.job.id, ...values, createdAt: timestamp })
        .returning();
  await event(tx, userId, "quickbooks.project_link_approved", context.job.id, {
    projectId: project.id,
    customerId: project.customerId,
    connectionId: context.c.id,
    note,
  });
  return saved as Link;
}

export async function readJobProjects(jobId: string) {
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!job) throw new DomainError(404, "Job not found.");
  const c = await getConnection();
  const capability = await projectsCapability(c);
  const [link] = await db.select().from(links).where(eq(links.jobId, jobId));
  const history = c
    ? await db
        .select()
        .from(reviews)
        .where(
          and(
            eq(reviews.jobId, jobId),
            eq(reviews.realmId, c.realmId),
            eq(reviews.environment, c.environment),
          ),
        )
    : [];
  const review =
    history.find((row) => row.connectionId === c?.id) ??
    history
      .filter((row) => row.submittedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const mappings = await db
    .select()
    .from(quickbooksEntityMappingsTable)
    .where(eq(quickbooksEntityMappingsTable.localId, jobId));
  const customer = mappings.find(
    (m) =>
      m.entityType === "customer" &&
      m.status === "linked" &&
      m.realmId === c?.realmId &&
      m.environment === c?.environment,
  );
  const legacy = mappings.find(
    (m) => m.entityType === "project" && m.status === "linked",
  );
  return {
    connection: publicCompany(c),
    capability,
    job: {
      id: job.id,
      jobNumber: job.jobNumber,
      revision: job.revision,
      updatedAt: job.updatedAt,
    },
    customer: customer
      ? { id: customer.quickbooksId, name: job.customerName }
      : null,
    link: projectLinkDto(link),
    legacySubcustomer: legacy ? { id: legacy.quickbooksId } : null,
    review: projectReviewDto(review),
  };
}
export async function projectCandidates(jobId: string, connectionId: string) {
  const context = await jobContext(jobId, connectionId);
  const result = await listCustomerProjects(
    graphFor(context.c),
    context.customer.id,
  );
  return { ...result, projects: result.projects.filter(usableProject) };
}
export async function approveProjectLink(
  jobId: string,
  input: {
    connectionId: string;
    jobRevision: number;
    projectId: string;
    linkRevision?: number;
    note: string;
  },
  userId: string,
) {
  const context = await jobContext(jobId, input.connectionId);
  const project = await getOwnedProject(
    graphFor(context.c),
    input.projectId,
    context.customer.id,
  );
  return db.transaction(async (tx) => {
    await lockContext(tx, context, input.jobRevision);
    const history = await tx
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.jobId, jobId),
          eq(reviews.realmId, context.c.realmId),
          eq(reviews.environment, context.c.environment),
        ),
      )
      .for("update");
    const review = history.find(
      (row) => row.submittedAt && row.status !== "linked",
    );
    if (review && !matchesReview(project, review))
      conflict(
        "A Project creation has an unresolved outcome. Reconcile that exact Project before linking a different one.",
      );
    const saved = await saveLink(
      tx,
      context,
      project,
      userId,
      input.note,
      input.linkRevision,
    );
    if (review?.submittedAt && matchesReview(project, review))
      await tx
        .update(reviews)
        .set({
          status: "linked",
          quickbooksProjectId: project.id,
          lastError: null,
          revision: review.revision + 1,
          updatedAt: now(),
        })
        .where(eq(reviews.id, review.id));
    return projectLinkDto(saved);
  });
}

export function projectReviewFingerprint(value: {
  connectionId: string;
  realmId: string;
  environment: string;
  jobId: string;
  jobRevision: number;
  jobUpdatedAt: string;
  quickbooksCustomerId: string;
  name: string;
  description: string;
}) {
  return hash([
    value.connectionId,
    value.realmId,
    value.environment,
    value.jobId,
    value.jobRevision,
    value.jobUpdatedAt,
    value.quickbooksCustomerId,
    value.name,
    value.description,
  ]);
}
function matchesReview(project: QboProject, review: Review) {
  return (
    project.customerId === review.quickbooksCustomerId &&
    project.name === review.name &&
    project.description === review.description &&
    usableProject(project)
  );
}
export async function prepareProjectReview(
  jobId: string,
  input: {
    connectionId: string;
    jobRevision: number;
    name: string;
    description?: string;
  },
  userId: string,
) {
  const context = await jobContext(jobId, input.connectionId);
  return db.transaction(async (tx) => {
    await lockContext(tx, context, input.jobRevision);
    const [linked] = await tx
      .select()
      .from(links)
      .where(eq(links.jobId, jobId));
    if (linked)
      conflict(
        "This job already has a true Project link. Review that link instead of creating another Project.",
      );
    const [existing] = await tx
      .select()
      .from(reviews)
      .where(
        and(eq(reviews.jobId, jobId), eq(reviews.connectionId, context.c.id)),
      )
      .for("update");
    const priorSubmissions = await tx
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.jobId, jobId),
          eq(reviews.realmId, context.c.realmId),
          eq(reviews.environment, context.c.environment),
        ),
      );
    if (priorSubmissions.some((row) => row.submittedAt))
      conflict(
        "A Project creation for this job and company was already submitted, including before reconnection. Reconcile its outcome; another creation is blocked.",
      );
    if (existing?.submittedAt)
      conflict(
        "This Project creation was already submitted. Reconcile its outcome; another creation is blocked.",
      );
    const id = existing?.id ?? randomUUID();
    const marker = `Catalyst Works project reference ${id}`;
    const requestedDescription = input.description?.trim() ?? "";
    const description = `${requestedDescription}${requestedDescription ? "\n\n" : ""}${marker}`;
    if (description.length > 4000)
      conflict("Shorten the Project description before reviewing it.");
    const timestamp = now();
    const values = {
      jobId,
      connectionId: context.c.id,
      realmId: context.c.realmId,
      environment: context.c.environment,
      quickbooksCustomerId: context.customer.id,
      name: input.name.trim(),
      description,
      jobRevision: context.job.revision,
      jobUpdatedAt: context.job.updatedAt,
      revision: (existing?.revision ?? 0) + 1,
      evidence: {
        customer: context.customer,
        scope: projectsScope,
        preferenceEnabled: true,
        probeSucceeded: true,
      },
      status: "pending_approval" as const,
      fingerprint: "",
      lastError: null,
      updatedAt: timestamp,
    };
    values.fingerprint = projectReviewFingerprint(values);
    const [review] = existing
      ? await tx
          .update(reviews)
          .set(values)
          .where(eq(reviews.id, id))
          .returning()
      : await tx
          .insert(reviews)
          .values({ id, ...values, createdAt: timestamp })
          .returning();
    await event(tx, userId, "quickbooks.project_create_reviewed", jobId, {
      reviewId: id,
      revision: values.revision,
      connectionId: context.c.id,
      fingerprint: values.fingerprint,
    });
    return projectReviewDto(review);
  });
}
async function loadReview(
  id: string,
  connectionId: string,
  revision: number,
  reconciliation = false,
) {
  const [review] = await db.select().from(reviews).where(eq(reviews.id, id));
  if (!review) throw new DomainError(404, "Project review not found.");
  if (
    (!reconciliation && review.connectionId !== connectionId) ||
    review.revision !== revision
  )
    conflict(
      "The Project review or company changed. Refresh before continuing.",
    );
  return review;
}
async function contextForReview(
  review: Review,
  connectionId = review.connectionId,
) {
  const context = await jobContext(review.jobId, connectionId);
  if (
    context.job.revision !== review.jobRevision ||
    context.job.updatedAt !== review.jobUpdatedAt ||
    context.customer.id !== review.quickbooksCustomerId ||
    context.c.realmId !== review.realmId ||
    context.c.environment !== review.environment
  )
    conflict(
      "The job, customer, or company changed since this Project review. Refresh and review again.",
    );
  return context;
}

export async function submitProjectReview(
  id: string,
  input: {
    connectionId: string;
    reviewRevision: number;
    fingerprint: string;
    note: string;
  },
  userId: string,
) {
  const review = await loadReview(id, input.connectionId, input.reviewRevision);
  if (
    review.status !== "pending_approval" ||
    review.submittedAt ||
    review.fingerprint !== input.fingerprint ||
    review.fingerprint !== projectReviewFingerprint(review)
  )
    conflict(
      "This Project review changed or was already submitted. Reconcile instead of submitting again.",
    );
  const context = await contextForReview(review);
  const candidates = await listCustomerProjects(
    graphFor(context.c),
    context.customer.id,
  );
  if (!candidates.complete)
    conflict(
      "The Project list exceeded the safe review limit. Select an existing Project or reconcile in QuickBooks; creation is blocked.",
    );
  if (
    candidates.projects.some(
      (project) =>
        project.name.trim().toLowerCase() === review.name.trim().toLowerCase(),
    )
  )
    conflict(
      "This customer already has a Project with that name. Explicitly select and link the existing Project.",
    );
  const submitted = await db.transaction(async (tx) => {
    await lockContext(tx, context, review.jobRevision);
    const [current] = await tx
      .select()
      .from(reviews)
      .where(eq(reviews.id, id))
      .for("update");
    if (
      current?.revision !== review.revision ||
      current.status !== "pending_approval" ||
      current.submittedAt ||
      current.fingerprint !== review.fingerprint
    )
      conflict(
        "This Project creation has already been claimed or changed. Refresh and reconcile.",
      );
    const [linked] = await tx
      .select()
      .from(links)
      .where(eq(links.jobId, review.jobId));
    if (linked)
      conflict("The job was linked to a Project while this review was open.");
    const timestamp = now();
    const [saved] = await tx
      .update(reviews)
      .set({
        status: "submitting",
        submittedAt: timestamp,
        approvedBy: userId,
        approvedAt: timestamp,
        revision: current.revision + 1,
        updatedAt: timestamp,
      })
      .where(eq(reviews.id, id))
      .returning();
    await event(
      tx,
      userId,
      "quickbooks.project_creation_submitted",
      review.jobId,
      {
        reviewId: id,
        connectionId: context.c.id,
        fingerprint: review.fingerprint,
        note: input.note,
      },
    );
    return saved;
  });
  // There is no documented GraphQL idempotency key. This durable claim is never reset.
  try {
    const data = graphData(
      await graphFor(context.c)("mutation", createProjectMutation, {
        name: review.name,
        description: review.description,
        customer: { id: review.quickbooksCustomerId },
      }),
    );
    const project = parseProject(data.projectManagementCreateProject);
    if (!matchesReview(project, review))
      throw new QuickBooksProjectsError(
        "QuickBooks returned a Project different from the approved review.",
        true,
      );
    return await finishProjectReview(submitted, project, userId, input.note);
  } catch (error) {
    const unknown =
      !(error instanceof QuickBooksProjectsError) || error.submissionUnknown;
    await db
      .update(reviews)
      .set({
        status: unknown ? "unknown" : "failed",
        lastError: unknown
          ? "The creation outcome is unconfirmed. Read-only reconciliation is required; another submission is blocked."
          : "QuickBooks refused the submitted creation. Review it in QuickBooks; this request cannot be submitted again.",
        revision: submitted.revision + 1,
        updatedAt: now(),
      })
      .where(and(eq(reviews.id, id), eq(reviews.status, "submitting")));
    const [saved] = await db.select().from(reviews).where(eq(reviews.id, id));
    return { review: projectReviewDto(saved), link: null };
  }
}
async function finishProjectReview(
  review: Review,
  project: QboProject,
  userId: string,
  note: string,
  connectionId = review.connectionId,
) {
  const context = await contextForReview(review, connectionId);
  // A second read proves the returned opaque ID and customer in the still-connected company.
  const verified = await getOwnedProject(
    graphFor(context.c),
    project.id,
    review.quickbooksCustomerId,
  );
  if (!matchesReview(verified, review))
    conflict(
      "The remote Project changed. Reconcile the original approved creation.",
    );
  return db.transaction(async (tx) => {
    await lockContext(tx, context, review.jobRevision);
    const [current] = await tx
      .select()
      .from(reviews)
      .where(eq(reviews.id, review.id))
      .for("update");
    if (!current?.submittedAt || current.revision !== review.revision)
      conflict("The Project review changed during reconciliation. Refresh it.");
    const [existing] = await tx
      .select()
      .from(links)
      .where(eq(links.jobId, review.jobId));
    if (
      existing &&
      (existing.connectionId !== context.c.id ||
        existing.quickbooksProjectId !== project.id)
    )
      conflict(
        "Another Project was linked while this creation was being reconciled.",
      );
    const link =
      existing ?? (await saveLink(tx, context, verified, userId, note));
    const [saved] = await tx
      .update(reviews)
      .set({
        status: "linked",
        quickbooksProjectId: verified.id,
        lastError: null,
        revision: current.revision + 1,
        updatedAt: now(),
      })
      .where(eq(reviews.id, review.id))
      .returning();
    return { review: projectReviewDto(saved), link: projectLinkDto(link) };
  });
}
export async function reconcileProjectReview(
  id: string,
  input: { connectionId: string; reviewRevision: number },
  userId: string,
) {
  const review = await loadReview(
    id,
    input.connectionId,
    input.reviewRevision,
    true,
  );
  if (!review.submittedAt)
    conflict("This Project review has not been submitted.");
  const context = await contextForReview(review, input.connectionId);
  const result = await listCustomerProjects(
    graphFor(context.c),
    review.quickbooksCustomerId,
  );
  const candidates = result.projects.filter((project) =>
    matchesReview(project, review),
  );
  if (!result.complete || candidates.length !== 1)
    return {
      review: projectReviewDto(review),
      candidates,
      link: null,
      complete: result.complete,
    };
  return {
    ...(await finishProjectReview(
      review,
      candidates[0],
      userId,
      "Owner requested reconciliation of the exact approved Project.",
      input.connectionId,
    )),
    candidates,
    complete: true,
  };
}

export async function verifiedProjectForJob(
  jobId: string,
  quickbooksCustomerId: string,
  connection: {
    id: string;
    realmId: string;
    environment: string;
    status: string;
    grantedScopes?: string[];
  },
) {
  const [link] = await db.select().from(links).where(eq(links.jobId, jobId));
  if (!link) return null;
  if (
    link.connectionId !== connection.id ||
    link.realmId !== connection.realmId ||
    link.environment !== connection.environment ||
    link.quickbooksCustomerId !== quickbooksCustomerId
  )
    conflict(
      "The true Project mapping belongs to a different customer or QuickBooks connection. Review it before exporting.",
    );
  const c = await connectionFor(connection.id);
  await requireCapability(c);
  const project = await getOwnedProject(
    graphFor(c),
    link.quickbooksProjectId,
    quickbooksCustomerId,
  );
  const fingerprint = hash([c.id, c.realmId, c.environment, project]);
  if (fingerprint !== link.fingerprint)
    conflict(
      "The QuickBooks Project changed since the owner approved it. Refresh and approve the Project link before exporting.",
    );
  return {
    kind: "qbo_project" as const,
    projectId: project.id,
    customerId: project.customerId,
    projectName: project.name,
    linkRevision: link.revision,
    fingerprint: link.fingerprint,
  };
}
