import { describe, expect, it, vi } from "vitest";
import {
  getOwnedProject,
  graphData,
  listCustomerProjects,
  projectsPreferenceEnabled,
  usableProject,
} from "./quickbooks-projects-graph";
const node = (id = "00042", customerId = "007", status = "OPEN") => ({
  id,
  name: "Floor replacement",
  description: "Reviewed scope",
  status,
  customer: { id: customerId },
});
const page = (
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
) => ({
  data: {
    projectManagementProjects: {
      edges: nodes.map((node) => ({ node })),
      pageInfo: { hasNextPage, endCursor },
    },
  },
});
describe("true Projects provider evidence", () => {
  it("requires the exact Projects preference, refusing missing, false and conflicting entries", () => {
    const pref = (rows: unknown[]) => ({
      Preferences: { OtherPrefs: { NameValue: rows } },
    });
    expect(
      projectsPreferenceEnabled(
        pref([{ Name: "ProjectsEnabled", Value: "true" }]),
      ),
    ).toBe(true);
    for (const body of [
      {},
      pref([{ Name: "ProjectsEnabled", Value: "false" }]),
      pref([{ Name: "Other", Value: "true" }]),
      pref([
        { Name: "ProjectsEnabled", Value: "true" },
        { Name: "ProjectsEnabled", Value: "false" },
      ]),
    ])
      expect(projectsPreferenceEnabled(body)).toBe(false);
  });
  it("rejects GraphQL errors even when partial data and HTTP success are present", () => {
    expect(() =>
      graphData({ ...page([]), errors: [{ message: "entitlement denied" }] }),
    ).toThrow(/errors/);
    expect(() => graphData({ data: null })).toThrow(/incomplete/);
  });
  it("paginates and locally enforces customer ownership when provider filters are ignored", async () => {
    const graph = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          [node("1", "999"), { ...node("unassigned"), customer: null }, node()],
          true,
          "cursor-one",
        ),
      )
      .mockResolvedValueOnce(page([node("43")]));
    expect(await listCustomerProjects(graph, "007")).toEqual({
      projects: [
        {
          id: "00042",
          name: "Floor replacement",
          description: "Reviewed scope",
          status: "OPEN",
          customerId: "007",
        },
        {
          id: "43",
          name: "Floor replacement",
          description: "Reviewed scope",
          status: "OPEN",
          customerId: "007",
        },
      ],
      complete: true,
    });
    expect(graph.mock.calls[1][2]).toMatchObject({
      after: "cursor-one",
      filter: {},
    });
  });
  it("does not claim a bounded, incomplete list proves absence", async () => {
    const graph = vi.fn().mockResolvedValue(page([node()], true, "cursor"));
    expect((await listCustomerProjects(graph, "007", 1)).complete).toBe(false);
  });
  it("fails closed on repeated cursors, missing cursors and conflicting duplicate IDs", async () => {
    await expect(
      listCustomerProjects(
        vi.fn().mockResolvedValue(page([], true, null)),
        "007",
      ),
    ).rejects.toThrow(/cursor/);
    await expect(
      listCustomerProjects(
        vi.fn().mockResolvedValue(page([], true, "repeat")),
        "007",
      ),
    ).rejects.toThrow(/cursor/);
    const graph = vi
      .fn()
      .mockResolvedValueOnce(page([node()], true, "first"))
      .mockResolvedValueOnce(page([{ ...node(), name: "Changed" }]));
    await expect(listCustomerProjects(graph, "007")).rejects.toThrow(/changed/);
  });
  it("verifies exact opaque ID, customer and open status on read", async () => {
    expect(
      (
        await getOwnedProject(
          vi
            .fn()
            .mockResolvedValue({ data: { projectManagementProject: node() } }),
          "00042",
          "007",
        )
      ).id,
    ).toBe("00042");
    const opaque = "project:00042/base64+=";
    expect(
      (
        await getOwnedProject(
          vi.fn().mockResolvedValue({
            data: { projectManagementProject: node(opaque) },
          }),
          opaque,
          "007",
        )
      ).id,
    ).toBe(opaque);
    for (const remote of [
      node("42"),
      node("00042", "7"),
      node("00042", "007", "COMPLETED"),
      node("00042", "007", "OTHER"),
    ])
      await expect(
        getOwnedProject(
          vi
            .fn()
            .mockResolvedValue({ data: { projectManagementProject: remote } }),
          "00042",
          "007",
        ),
      ).rejects.toThrow(/open Project/);
    expect(
      usableProject({
        id: "1",
        customerId: "2",
        name: "Test",
        description: "",
        status: "NEW_UNKNOWN_STATE",
      }),
    ).toBe(false);
  });
});
