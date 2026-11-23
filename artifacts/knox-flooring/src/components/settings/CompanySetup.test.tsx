import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanySetup } from "./CompanySetup";

const state = vi.hoisted(() => ({ fetch: vi.fn(), user: null as any }));
vi.mock("@workspace/api-client-react", () => ({ customFetch: state.fetch }));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: state.user }) }));
const readiness = () => ({
  checkedAt: "2026-11-23T00:00:00Z",
  setupStepsCompleted: 1,
  setupStepCount: 3,
  configurationExportAvailable: true,
  clientProductionAcceptanceComplete: false,
  steps: [
    {
      key: "quickbooks_server",
      title: "QuickBooks server configuration",
      state: "complete",
      detail: "Saved server settings only.",
      href: "/settings",
    },
    {
      key: "quickbooks_connection",
      title: "Saved QuickBooks company authorization",
      state: "missing",
      detail: "Owner company consent is missing.",
      href: "/settings",
    },
    {
      key: "provider_acceptance",
      title: "End-to-end provider acceptance",
      state: "acceptance_pending",
      detail: "No real provider acceptance is recorded.",
      href: "/settings",
    },
  ],
});
beforeEach(() => {
  vi.resetAllMocks();
  state.user = {
    id: "owner",
    role: "owner",
    actualRole: "owner",
    previewRole: null,
  };
  state.fetch.mockResolvedValue(readiness());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows saved configuration separately from missing consent and unverified provider acceptance", async () => {
  render(<CompanySetup />);
  expect(
    await screen.findByText("1 of 3 setup steps have saved configuration."),
  ).toBeVisible();
  expect(screen.getByText("Saved")).toBeVisible();
  expect(screen.getByText("Needs setup")).toBeVisible();
  expect(screen.getByText("Acceptance pending")).toBeVisible();
  expect(
    screen.getByText(/Client and provider acceptance remain pending/),
  ).toBeVisible();
  expect(state.fetch).toHaveBeenCalledTimes(1);
  expect(state.fetch).toHaveBeenCalledWith(
    "/api/company-setup/readiness",
    expect.objectContaining({ responseType: "json" }),
  );
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
it("makes no checklist or export request for staff or any role preview", () => {
  for (const user of [
    null,
    { id: "sales", role: "sales", actualRole: "sales" },
    { id: "owner", role: "sales", actualRole: "owner", previewRole: "sales" },
    { id: "owner", role: "owner", actualRole: "owner", previewRole: "owner" },
  ]) {
    state.user = user;
    const view = render(<CompanySetup />);
    expect(view.container).toBeEmptyDOMElement();
    view.unmount();
  }
  expect(state.fetch).not.toHaveBeenCalled();
});
it("downloads only the authenticated versioned export and disposes the temporary URL", async () => {
  const blob = new Blob(['{"schemaVersion":1}'], { type: "application/json" });
  const create = vi.fn(() => "blob:fixture-private-export"),
    revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  const clicks: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ href: this.href, download: this.download });
  });
  state.fetch.mockImplementation(async (path: string) =>
    path.endsWith("/readiness") ? readiness() : blob,
  );
  render(<CompanySetup />);
  const button = await screen.findByRole("button", {
    name: "Export company settings",
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Company settings exported",
  );
  expect(state.fetch).toHaveBeenLastCalledWith(
    "/api/company-setup/configuration-export",
    { responseType: "blob" },
  );
  expect(create).toHaveBeenCalledWith(blob);
  expect(clicks).toEqual([
    {
      href: "blob:fixture-private-export",
      download: "catalyst-works-company-configuration-v1.json",
    },
  ]);
  expect(revoke).toHaveBeenCalledWith("blob:fixture-private-export");
  expect(document.querySelector("a[download]")).toBeNull();
});
it("does not show stale completed steps or enable export when readiness fails", async () => {
  state.fetch.mockRejectedValue(new Error("PRIVATE_DATABASE_RESPONSE"));
  render(<CompanySetup />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Company setup could not be checked",
  );
  expect(
    screen.queryByText(/setup steps have saved configuration/),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Export company settings" }),
  ).toBeDisabled();
  expect(
    screen.queryByText("PRIVATE_DATABASE_RESPONSE"),
  ).not.toBeInTheDocument();
});
it("refreshes saved readiness without sending a completion flag", async () => {
  render(<CompanySetup />);
  expect(await screen.findByText("Saved")).toBeVisible();
  const changed = readiness();
  changed.steps[0].state = "missing";
  changed.setupStepsCompleted = 0;
  state.fetch.mockResolvedValue(changed);
  fireEvent.click(screen.getByRole("button", { name: "Refresh setup" }));
  expect(
    await screen.findByText("0 of 3 setup steps have saved configuration."),
  ).toBeVisible();
  expect(state.fetch).toHaveBeenCalledTimes(2);
  expect(
    state.fetch.mock.calls.every(
      ([, options]) =>
        options.responseType === "json" && !options.method && !options.body,
    ),
  ).toBe(true);
});
