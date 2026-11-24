import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ query: "" }));
vi.mock("wouter", () => ({ useSearch: () => state.query }));
import { QuickBooksOAuthNotice } from "./QuickBooksOAuthNotice";
afterEach(() => {
  cleanup();
  state.query = "";
});

it.each([
  ["invalid", /expired or could not be verified/],
  ["cancelled", /was cancelled/],
  ["sign_in_required", /Sign in with the owner/],
  ["owner_required", /outside role preview/],
  ["blocked", /pending revocation/],
  ["failed", /could not be confirmed/],
])(
  "shows useful safe %s guidance without echoing provider input",
  (outcome, message) => {
    state.query = `quickbooks=${outcome}&code=SENTINEL-CODE&state=SENTINEL-STATE&error_description=SENTINEL-ERROR&realmId=987654321`;
    render(<QuickBooksOAuthNotice />);
    expect(screen.getByRole("status")).toHaveTextContent(message);
    expect(document.body.textContent).not.toMatch(/SENTINEL|987654321/);
  },
);
it("does not turn an editable success query parameter into a verified connection claim", () => {
  state.query = "quickbooks=connected";
  render(<QuickBooksOAuthNotice />);
  expect(screen.getByRole("status")).toHaveTextContent(
    /Verify the saved company and environment/,
  );
  expect(screen.getByRole("status")).not.toHaveTextContent(
    /successfully connected/i,
  );
});
it.each([
  "",
  "quickbooks=__proto__",
  "quickbooks=%3Cscript%3ESENTINEL%3C%2Fscript%3E",
])("ignores unknown or absent callback data: %s", (query) => {
  state.query = query;
  render(<QuickBooksOAuthNotice />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("SENTINEL");
});
