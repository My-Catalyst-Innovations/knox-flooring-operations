import { z } from "zod";

// Official Intuit Projects sample uses these connection fields. Filters are deliberately
// empty: the sample documents that ID/status filters may be ignored by the provider.
export const projectFields = "id name description status customer { id }";
export const projectsQuery = `query CatalystProjects($first: PositiveInt!, $after: String, $filter: ProjectManagement_ProjectFilter!) { projectManagementProjects(first:$first,after:$after,filter:$filter) { edges { node { ${projectFields} } } pageInfo { hasNextPage endCursor } } }`;
export const projectQuery = `query CatalystProject($id: ID!) { projectManagementProject(id:$id) { ${projectFields} } }`;
export const createProjectMutation = `mutation CatalystCreateProject($name:String!,$description:String,$customer:ProjectManagement_CustomerInput) { projectManagementCreateProject(input:{name:$name,description:$description,status:OPEN,customer:$customer}) { ... on ProjectManagement_Project { ${projectFields} } } }`;
// GraphQL IDs are opaque strings; preserve leading zeroes and encoded characters.
export const projectId = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim() && !/\p{C}/u.test(value));
const remoteProject = z.object({
  id: projectId,
  name: z.string().min(1).max(500),
  description: z.string().nullable().optional(),
  status: z.string().min(1),
  customer: z.object({ id: projectId }).nullable(),
});
export type QboProject = {
  id: string;
  name: string;
  description: string;
  status: string;
  customerId: string;
};
export type ProjectsGraph = (
  operation: "query" | "mutation",
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;
export class QuickBooksProjectsError extends Error {
  constructor(
    message: string,
    readonly submissionUnknown = false,
    readonly status = 409,
  ) {
    super(message);
  }
}
export function graphData(body: unknown): Record<string, unknown> {
  const parsed = z
    .object({
      data: z.record(z.string(), z.unknown()).nullable().optional(),
      errors: z.array(z.unknown()).optional(),
    })
    .safeParse(body);
  if (!parsed.success || parsed.data.errors?.length || !parsed.data.data)
    throw new QuickBooksProjectsError(
      "QuickBooks Projects returned errors or incomplete data; review the connection before continuing.",
      true,
    );
  return parsed.data.data;
}
export function parseProject(value: unknown): QboProject {
  const parsed = remoteProject.safeParse(value);
  if (!parsed.success || !parsed.data.customer)
    throw new QuickBooksProjectsError(
      "QuickBooks returned a Project without a verifiable customer.",
      true,
    );
  return {
    id: parsed.data.id,
    name: parsed.data.name,
    description: parsed.data.description ?? "",
    status: parsed.data.status,
    customerId: parsed.data.customer.id,
  };
}
export const usableProject = (project: QboProject) =>
  ["OPEN", "IN_PROGRESS"].includes(project.status);
export function projectsPreferenceEnabled(body: unknown) {
  const parsed = z
    .object({
      Preferences: z.object({
        OtherPrefs: z.object({
          NameValue: z.array(
            z.object({ Name: z.string(), Value: z.unknown() }),
          ),
        }),
      }),
    })
    .safeParse(body);
  if (!parsed.success) return false;
  const values = parsed.data.Preferences.OtherPrefs.NameValue.filter(
    (row) => row.Name === "ProjectsEnabled",
  );
  return (
    values.length === 1 &&
    (values[0].Value === "true" || values[0].Value === true)
  );
}
export async function listCustomerProjects(
  graph: ProjectsGraph,
  customerId: string,
  maxPages = 10,
) {
  let after: string | undefined;
  const seenCursors = new Set<string>();
  const all = new Map<string, QboProject>();
  for (let page = 0; page < maxPages; page++) {
    const data = graphData(
      await graph("query", projectsQuery, {
        first: 50,
        after: after ?? null,
        filter: {},
      }),
    );
    const parsed = z
      .object({
        edges: z.array(z.object({ node: z.unknown() })).max(50),
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable().optional(),
        }),
      })
      .safeParse(data.projectManagementProjects);
    if (!parsed.success)
      throw new QuickBooksProjectsError(
        "QuickBooks returned incomplete Project pagination.",
      );
    for (const edge of parsed.data.edges) {
      const node = remoteProject.safeParse(edge.node);
      // An unassigned Project cannot belong to the reviewed customer. Missing or
      // malformed customer evidence still fails closed through parseProject.
      if (node.success && node.data.customer === null) continue;
      const project = parseProject(edge.node);
      const previous = all.get(project.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(project))
        throw new QuickBooksProjectsError(
          "QuickBooks Projects changed during listing. Refresh the list.",
        );
      all.set(project.id, project);
    }
    const projects = [...all.values()].filter(
      (project) => project.customerId === customerId,
    );
    if (!parsed.data.pageInfo.hasNextPage) return { projects, complete: true };
    const cursor = parsed.data.pageInfo.endCursor;
    if (!cursor || seenCursors.has(cursor))
      throw new QuickBooksProjectsError(
        "QuickBooks returned a repeated or missing Project cursor.",
      );
    seenCursors.add(cursor);
    after = cursor;
    if (page === maxPages - 1) return { projects, complete: false };
  }
  return { projects: [] as QboProject[], complete: false };
}
export async function getOwnedProject(
  graph: ProjectsGraph,
  id: string,
  customerId: string,
) {
  const data = graphData(await graph("query", projectQuery, { id }));
  const project = parseProject(data.projectManagementProject);
  if (
    project.id !== id ||
    project.customerId !== customerId ||
    !usableProject(project)
  )
    throw new QuickBooksProjectsError(
      "Select an open Project owned by this job's verified QuickBooks customer.",
    );
  return project;
}
