import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuickBooksEntry } from "./quickbooks-entry";
import QuickBooksHelp from "./quickbooks-help";
import type { QuickBooksEntryStatus } from "@/lib/quickbooks-entry";
const state = vi.hoisted(() => ({
  user: null as any,
  request: vi.fn(),
  navigate: vi.fn(),
  loading: false,
}));
vi.mock("@/contexts/auth", () => ({
  useAuth: () => ({ user: state.user, loading: state.loading }),
}));
vi.mock("@workspace/api-client-react", () => ({ customFetch: state.request }));
const connected: QuickBooksEntryStatus = {
  configured: true,
  connection: {
    connected: true,
    status: "connected",
    localUseStopped: false,
    revocationRetryAvailable: false,
    companyName: "Saved company",
    environment: "sandbox",
    revocation: "not_requested",
  },
};
const stopped = (
  revocation: "pending" | "unknown" | "failed" | "confirmed",
): QuickBooksEntryStatus => ({
  ...connected,
  connection: {
    ...connected.connection,
    connected: false,
    status: "disconnected",
    localUseStopped: true,
    revocationRetryAvailable: true,
    revocation,
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  state.request.mockReset();
  state.user = {
    id: "owner-1",
    role: "owner",
    actualRole: "owner",
    previewRole: null,
  };
  state.loading = false;
  window.history.replaceState({}, "", "/");
  state.request.mockResolvedValue(structuredClone(connected));
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});
it.each([
  null,
  { role: "sales" },
  { role: "operations" },
  { role: "installer" },
  { role: "owner", actualRole: "sales" },
  { role: "owner", previewRole: "installer" },
])(
  "does not read or mutate company connections without an actual owner: %j",
  (user) => {
    state.user = user;
    render(<QuickBooksEntry intent="disconnect" navigate={state.navigate} />);
    expect(state.request).not.toHaveBeenCalled();
    expect(screen.queryByText("Saved company")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    if (!user)
      expect(
        screen.getByRole("link", { name: "Sign in to continue" }),
      ).toHaveAttribute("href", "/welcome?continue=quickbooks_disconnect");
  },
);
it("opens an owner disconnect bookmark as a read-only local status lookup and ignores query claims", async () => {
  window.history.replaceState(
    {},
    "",
    "/integrations/quickbooks/disconnect?realmId=SENTINEL&state=SENTINEL&connected=true",
  );
  render(<QuickBooksEntry intent="disconnect" navigate={state.navigate} />);
  expect(await screen.findByText("Saved company")).toBeInTheDocument();
  expect(state.request).toHaveBeenCalledExactlyOnceWith(
    "/api/quickbooks/entry-status",
    expect.objectContaining({ responseType: "json" }),
  );
  expect(state.navigate).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("SENTINEL");
  expect(
    screen.getByRole("button", { name: "Stop use and request revocation" }),
  ).toBeDisabled();
});
it("starts reauthorization only on click and navigates only to a verified Intuit URL", async () => {
  const url =
    "https://appcenter.intuit.com/connect/oauth2?client_id=example&state=opaque";
  state.request.mockImplementation(async (path) =>
    path === "/api/quickbooks/entry-status"
      ? connected
      : { authorizationUrl: url },
  );
  render(<QuickBooksEntry intent="reconnect" navigate={state.navigate} />);
  const connect = await screen.findByRole("button", {
    name: "Reauthorize QuickBooks",
  });
  expect(state.request).toHaveBeenCalledTimes(1);
  fireEvent.click(connect);
  await waitFor(() =>
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith(url),
  );
  expect(state.request).toHaveBeenLastCalledWith("/api/quickbooks/connect", {
    responseType: "json",
  });
});
it("refuses a returned external or unsafe authorization destination", async () => {
  state.request.mockImplementation(async (path) =>
    path === "/api/quickbooks/entry-status"
      ? connected
      : { authorizationUrl: "https://untrusted.invalid?state=SENTINEL" },
  );
  render(<QuickBooksEntry intent="reconnect" navigate={state.navigate} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Reauthorize QuickBooks" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not be started safely",
  );
  expect(state.navigate).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("SENTINEL");
});
it("does not navigate an in-flight authorization after the owner role is lost", async () => {
  let resolve!: (value: unknown) => void;
  state.request.mockImplementation((path) =>
    path === "/api/quickbooks/entry-status"
      ? Promise.resolve(connected)
      : new Promise((done) => {
          resolve = done;
        }),
  );
  const { rerender } = render(
    <QuickBooksEntry intent="reconnect" navigate={state.navigate} />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Reauthorize QuickBooks" }),
  );
  state.user = { id: "owner-1", role: "operations", actualRole: "operations" };
  rerender(<QuickBooksEntry intent="reconnect" navigate={state.navigate} />);
  resolve({
    authorizationUrl:
      "https://appcenter.intuit.com/connect/oauth2?state=example",
  });
  await waitFor(() =>
    expect(
      screen.getByText(/current sign-in cannot view or change/),
    ).toBeInTheDocument(),
  );
  expect(state.navigate).not.toHaveBeenCalled();
});
it.each([true, false])(
  "keeps missing legacy revocation outcomes unconfirmed with retry availability %s",
  async (available) => {
    state.request.mockResolvedValue({
      ...stopped("unknown"),
      connection: {
        ...stopped("unknown").connection,
        revocation: "not_requested",
        revocationRetryAvailable: available,
      },
    });
    render(<QuickBooksEntry intent="disconnect" navigate={state.navigate} />);
    expect(
      await screen.findByText("No revocation outcome recorded — not confirmed"),
    ).toBeInTheDocument();
    const retry = screen.getByRole("button", {
      name: "Retry Intuit revocation",
    });
    if (available) {
      fireEvent.click(screen.getByRole("checkbox"));
      expect(retry).toBeEnabled();
    } else {
      expect(retry).toBeDisabled();
      expect(
        screen.getByText(/cannot currently be retried safely/),
      ).toBeInTheDocument();
    }
    expect(state.request).toHaveBeenCalledTimes(1);
  },
);
it.each(["pending", "unknown", "failed"] as const)(
  "keeps %s revocation unresolved and blocks new authorization",
  async (revocation) => {
    state.request.mockResolvedValue(stopped(revocation));
    render(<QuickBooksEntry intent="reconnect" navigate={state.navigate} />);
    const connect = await screen.findByRole("button", {
      name: "Continue to Intuit authorization",
    });
    expect(connect).toBeDisabled();
    expect(screen.getByText(/New authorization is paused/)).toBeInTheDocument();
    expect(state.request).toHaveBeenCalledTimes(1);
    expect(state.navigate).not.toHaveBeenCalled();
  },
);
it("requires explicit confirmation before local stop and rereads state without claiming unknown revocation", async () => {
  state.request
    .mockResolvedValueOnce(connected)
    .mockResolvedValueOnce({ revocation: "unknown" })
    .mockResolvedValueOnce(stopped("unknown"));
  render(<QuickBooksEntry intent="disconnect" navigate={state.navigate} />);
  const stop = await screen.findByRole("button", {
    name: "Stop use and request revocation",
  });
  expect(stop).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(stop);
  await waitFor(() =>
    expect(state.request).toHaveBeenCalledWith("/api/quickbooks/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retryRevocation: false }),
      responseType: "json",
    }),
  );
  expect(await screen.findByText("Local use stopped")).toBeInTheDocument();
  expect(screen.getByText("Unknown — not confirmed")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Retry Intuit revocation" }),
  ).toBeDisabled();
  expect(
    state.request.mock.calls.filter(
      ([, options]) => options?.method === "POST",
    ),
  ).toHaveLength(1);
});
it("retries only the same stopped grant after another owner confirmation", async () => {
  state.request
    .mockResolvedValueOnce(stopped("unknown"))
    .mockResolvedValueOnce({ revocation: "confirmed" })
    .mockResolvedValueOnce(stopped("confirmed"));
  render(<QuickBooksEntry intent="disconnect" navigate={state.navigate} />);
  const retry = await screen.findByRole("button", {
    name: "Retry Intuit revocation",
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(retry);
  await waitFor(() =>
    expect(state.request).toHaveBeenCalledWith(
      "/api/quickbooks/disconnect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ retryRevocation: true }),
      }),
    ),
  );
  expect(
    await screen.findByText("Confirmed for the stopped grant"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry Intuit revocation" }),
  ).toBeNull();
});
it("keeps an interrupted disconnect uncertain and does not retry automatically", async () => {
  state.request
    .mockResolvedValueOnce(connected)
    .mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_TOKEN"))
    .mockResolvedValueOnce(stopped("pending"));
  render(<QuickBooksEntry intent="disconnect" navigate={state.navigate} />);
  await screen.findByText("Saved company");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Stop use and request revocation" }),
  );
  expect(
    await screen.findByText(/The disconnect response could not be confirmed/),
  ).toBeInTheDocument();
  expect(
    await screen.findByText("Pending — not confirmed"),
  ).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("PRIVATE_PROVIDER_TOKEN");
  expect(
    state.request.mock.calls.filter(
      ([, options]) => options?.method === "POST",
    ),
  ).toHaveLength(1);
});
it("fails closed on status errors or missing provider configuration", async () => {
  state.request.mockRejectedValueOnce(new Error("PRIVATE_DATABASE_DETAILS"));
  render(<QuickBooksEntry intent="connect" navigate={state.navigate} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not be verified",
  );
  expect(
    screen.queryByRole("button", { name: "Continue to Intuit authorization" }),
  ).toBeNull();
  expect(document.body.textContent).not.toContain("PRIVATE_DATABASE_DETAILS");
});
it("offers genuine help with server-owned legal links and no account/provider actions", () => {
  state.user = null;
  render(<QuickBooksHelp />);
  expect(
    screen.getByRole("heading", { name: "QuickBooks connection help" }),
  ).toBeInTheDocument();
  expect(state.request).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Privacy notice" }).tagName).toBe(
    "A",
  );
  expect(screen.getByRole("link", { name: "Privacy notice" })).toHaveAttribute(
    "href",
    "/privacy",
  );
  expect(screen.getByRole("link", { name: "Terms of use" })).toHaveAttribute(
    "href",
    "/terms",
  );
  expect(
    screen.queryByText(/sign up|start trial|approved by Intuit/i),
  ).toBeNull();
});
