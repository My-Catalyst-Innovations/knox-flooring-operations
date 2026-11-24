import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { WorkspaceRouter } from "./App";

const state = vi.hoisted(() => ({
  user: null as any,
  listeners: new Set<() => void>(),
  officeLayout: vi.fn(),
  store: vi.fn(),
  queries: [] as string[],
  operation: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  preview: vi.fn(),
  refetch: vi.fn(),
  profile: {
    id: "installer",
    name: "Installer",
    email: "staff@example.invalid",
    phone: "",
    jobTitle: "Installer",
    role: "installer",
  },
}));
function setUser(user: any) {
  state.user = user;
  state.listeners.forEach((notify) => notify());
}
vi.mock("@/contexts/auth", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    AuthProvider: ({ children }: any) => children,
    useAuth: () => ({
      user: useSyncExternalStore(
        (notify) => {
          state.listeners.add(notify);
          return () => state.listeners.delete(notify);
        },
        () => state.user,
      ),
      loading: false,
      login: state.login,
      logout: state.logout,
      switchPersona: state.preview,
      refreshSession: vi.fn(),
      forgot: vi.fn(),
      reset: vi.fn(),
      acceptInvitation: vi.fn(),
      enterDemo: vi.fn(),
    }),
  };
});
vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: ({ children }: any) => {
    state.officeLayout();
    state.store();
    return <div data-testid="office-layout">{children}</div>;
  },
}));
vi.mock("@/pages/dashboard", () => ({
  default: () => <h1>Office dashboard</h1>,
}));
vi.mock("@/lib/platform-client", () => ({
  platformRequest: async () => ({ enabled: false }),
}));
vi.mock("@/lib/operations", async (original) => ({
  ...(await original<any>()),
  operation: (...args: any[]) => state.operation(...args),
  useOperation: (path: string, roles?: string[]) => {
    const allowed = !!state.user && (!roles || roles.includes(state.user.role));
    if (allowed) state.queries.push(path);
    const data =
      path === "/auth/profile"
        ? state.profile
        : path === "/work-guides/jobs"
          ? {
              jobs: [
                {
                  id: "assigned-job",
                  jobNumber: "J-1",
                  customerName: "Assigned customer",
                  status: "Scheduled",
                },
              ],
              hasMore: false,
            }
          : {
              job: {
                id: "assigned-job",
                jobNumber: "J-1",
                customerName: "Assigned customer",
                address: "100 Site Way",
                city: "Knoxville",
                flooringType: "Tile",
                scopeOfWork:
                  "Flooring: Tile. 0 recorded room(s). Confirm installation instructions with the office.",
                rooms: [],
                status: "Scheduled",
              },
              tasks: [],
              bookings: [],
              materials: [],
              ownUpdates: [],
              orders: [],
              selectedOrderId: null,
              warehouse: null,
              installation: [],
              checkedAt: "2026-11-23T18:00:00Z",
            };
    return {
      allowed,
      data: allowed ? data : undefined,
      refetch: state.refetch,
      isLoading: false,
      isError: false,
      isFetching: false,
    };
  },
}));

const installer = {
  id: "installer",
  name: "Installer",
  role: "installer",
  actualRole: "installer",
  previewRole: null,
};
function open(path: string) {
  const location = memoryLocation({ path, record: true });
  render(
    <Router hook={location.hook}>
      <WorkspaceRouter />
    </Router>,
  );
  return location;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.queries = [];
  state.user = installer;
  state.operation.mockResolvedValue({ demoAccessEnabled: false });
  state.login.mockImplementation(async () => setUser(installer));
  state.logout.mockImplementation(async () => setUser(null));
  state.preview.mockImplementation(async () =>
    setUser({
      id: "owner",
      name: "Owner",
      role: "owner",
      actualRole: "owner",
      previewRole: null,
    }),
  );
});
afterEach(() => {
  cleanup();
  state.listeners.clear();
});

it.each(["/", "/jobs", "/tasks?create=1", "/settings", "/unknown"])(
  "routes an installer %s bookmark to safe work without mounting the office store",
  async (path) => {
    const location = open(path);
    expect(
      await screen.findByRole("heading", { name: "Work guides" }),
    ).toBeVisible();
    expect(location.history?.at(-1)).toBe("/work-guides");
    expect(state.officeLayout).not.toHaveBeenCalled();
    expect(state.store).not.toHaveBeenCalled();
    expect(
      state.queries.every((query) => query.startsWith("/work-guides/")),
    ).toBe(true);
    expect(screen.getByRole("link", { name: "My profile" })).toHaveAttribute(
      "href",
      "/profile",
    );
  },
);
it("preserves an explicitly selected job on an old job URL and never requests the legacy full job", async () => {
  const location = open("/jobs/assigned-job");
  expect(await screen.findByText("J-1 · Assigned customer")).toBeVisible();
  expect(location.history?.at(-1)).toBe("/work-guides?job=assigned-job");
  expect(state.queries).toContain("/work-guides/jobs/assigned-job");
  expect(state.queries).not.toContain("/jobs/assigned-job");
  expect(state.officeLayout).not.toHaveBeenCalled();
});
it("sends a successful real sign-in to installer work rather than mounting the office dashboard", async () => {
  state.user = null;
  open("/welcome");
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "staff@example.invalid" },
  });
  fireEvent.change(screen.getByLabelText("Password", { exact: true }), {
    target: { value: "synthetic-fixture-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(
    await screen.findByRole("heading", { name: "Work guides" }),
  ).toBeVisible();
  expect(state.login).toHaveBeenCalledWith(
    "staff@example.invalid",
    "synthetic-fixture-password",
  );
  expect(state.officeLayout).not.toHaveBeenCalled();
});
it("keeps own profile functional outside the office store and returns to safe work", async () => {
  open("/profile");
  expect(await screen.findByLabelText("Full name")).toHaveValue("Installer");
  fireEvent.change(screen.getByLabelText("Full name"), {
    target: { value: "Installer Updated" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() =>
    expect(state.operation).toHaveBeenCalledWith("/auth/profile", "PATCH", {
      name: "Installer Updated",
      phone: "",
      jobTitle: "Installer",
    }),
  );
  expect(state.officeLayout).not.toHaveBeenCalled();
  expect(state.queries.every((query) => query === "/auth/profile")).toBe(true);
  fireEvent.click(screen.getByRole("link", { name: "My work" }));
  expect(
    await screen.findByRole("heading", { name: "Work guides" }),
  ).toBeVisible();
});
it("uses effective installer preview and offers an explicit exit without granting office access", async () => {
  state.user = {
    ...installer,
    id: "owner",
    actualRole: "owner",
    previewRole: "installer",
  };
  const location = open("/");
  expect(
    await screen.findByRole("button", { name: "Exit role preview" }),
  ).toBeVisible();
  expect(state.officeLayout).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Exit role preview" }));
  await waitFor(() => expect(state.preview).toHaveBeenCalledWith(null));
  act(() => location.navigate("/"));
  expect(
    await screen.findByRole("heading", { name: "Office dashboard" }),
  ).toBeVisible();
});
it("keeps safe work-order URLs outside the office layout and never forwards stale warehouse selection for an installer", async () => {
  const location = open("/jobs/assigned-job/work-order");
  expect(
    await screen.findByRole("heading", { name: "Work order J-1" }),
  ).toBeVisible();
  expect(state.queries).toContain("/work-guides/jobs/assigned-job/work-order");
  act(() =>
    location.navigate("/work-guides?job=assigned-job&order=office-order"),
  );
  expect(
    await screen.findByRole("heading", { name: "Work guides" }),
  ).toBeVisible();
  expect(state.queries.some((query) => query.includes("order="))).toBe(false);
  expect(state.officeLayout).not.toHaveBeenCalled();
});
it.each(["owner", "operations", "sales"])(
  "retains the %s workspace routing",
  async (role) => {
    state.user = {
      id: role,
      name: role,
      role,
      actualRole: role,
      previewRole: null,
    };
    open("/");
    expect(
      await screen.findByRole("heading", { name: "Office dashboard" }),
    ).toBeVisible();
    expect(state.officeLayout).toHaveBeenCalled();
  },
);
