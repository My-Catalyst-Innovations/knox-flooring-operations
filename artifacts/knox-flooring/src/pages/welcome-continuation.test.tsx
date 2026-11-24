import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Welcome from "./welcome";
const state = vi.hoisted(() => ({
  login: vi.fn(),
  location: vi.fn(),
  search: "",
}));
vi.mock("@/contexts/auth", () => ({
  useAuth: () => ({
    login: state.login,
    enterDemo: vi.fn(),
    forgot: vi.fn(),
    reset: vi.fn(),
    acceptInvitation: vi.fn(),
  }),
}));
vi.mock("wouter", () => ({
  useSearch: () => state.search,
  useLocation: () => ["/welcome", state.location],
  Link: ({ href, children }: any) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/platform-client", () => ({
  platformRequest: async () => ({ enabled: false }),
}));
vi.mock("@/lib/operations", () => ({
  operation: async () => ({ demoAccessEnabled: false }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.login.mockResolvedValue(undefined);
  state.search = "";
  window.history.replaceState({}, "", "/welcome");
});
afterEach(cleanup);
it.each(["launch", "connect", "reconnect", "disconnect"])(
  "continues successful sign-in only to the closed QuickBooks %s destination",
  async (intent) => {
    state.search = `continue=quickbooks_${intent}`;
    render(<Welcome />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "Example password only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(state.location).toHaveBeenCalledWith(
        `/integrations/quickbooks/${intent}`,
      ),
    );
    expect(state.login).toHaveBeenCalledExactlyOnceWith(
      "owner@example.test",
      "Example password only",
    );
  },
);
it.each([
  "continue=https://evil.invalid",
  "continue=//evil.invalid",
  "continue=javascript:alert(1)",
  "continue=quickbooks_disconnect&continue=quickbooks_connect",
  "returnTo=https://evil.invalid",
  "continue=__proto__",
])(
  "never follows an arbitrary or ambiguous return destination: %s",
  async (search) => {
    state.search = search;
    render(<Welcome />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "Example password only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(state.location).toHaveBeenCalledWith("/"));
    expect(document.body.textContent).not.toContain("evil.invalid");
  },
);
it("keeps failed sign-in on the sign-in page without continuing or issuing an account action", async () => {
  state.search = "continue=quickbooks_disconnect";
  state.login.mockRejectedValueOnce(new Error("Sign in failed"));
  render(<Welcome />);
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "owner@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "Incorrect example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Sign in failed");
  expect(state.location).not.toHaveBeenCalled();
});
