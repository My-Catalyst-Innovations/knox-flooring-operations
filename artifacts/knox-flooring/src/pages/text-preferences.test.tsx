import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TextPreferences from "./text-preferences";
import type { SmsPreference } from "@/components/communications/sms-preference-panel";

const state = vi.hoisted(() => ({
  user: {
    role: "owner",
    actualRole: "owner",
    previewRole: null as string | null,
  },
  useOperation: vi.fn(),
  operation: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/operations", () => ({
  useOperation: state.useOperation,
  operation: state.operation,
}));
const preference: SmsPreference = {
  to: "+18655550123",
  revision: 2,
  binding: null,
  permission: {
    status: "suppressed",
    canSendLive: false,
    canDeviceShare: false,
    reason: "This recipient is opted out for this company.",
  },
  history: [],
  hasMore: false,
};
beforeEach(() => {
  state.user = { role: "owner", actualRole: "owner", previewRole: null };
  state.operation.mockReset();
  state.refetch.mockReset();
  state.useOperation.mockReset().mockReturnValue({
    refetch: state.refetch,
    isError: false,
    isFetching: false,
  });
});
afterEach(cleanup);
function lookup(value = "(865) 555-0123") {
  fireEvent.change(screen.getByLabelText("Recipient phone number"), {
    target: { value },
  });
  fireEvent.click(screen.getByRole("button", { name: "Look up preference" }));
}
it("looks up only an explicitly selected normalized number and performs no mutation on opening", () => {
  render(<TextPreferences />);
  expect(state.useOperation).toHaveBeenLastCalledWith(
    "/sms-preferences/recipient?to=",
    [],
  );
  fireEvent.change(screen.getByLabelText("Recipient phone number"), {
    target: { value: "(865) 555-0123" },
  });
  expect(state.useOperation).toHaveBeenLastCalledWith(
    "/sms-preferences/recipient?to=",
    [],
  );
  fireEvent.click(screen.getByRole("button", { name: "Look up preference" }));
  expect(state.useOperation).toHaveBeenLastCalledWith(
    "/sms-preferences/recipient?to=%2B18655550123",
    ["owner", "sales", "operations"],
  );
  expect(state.operation).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Send from company number" }),
  ).not.toBeInTheDocument();
});
it.each(["sales", "operations"])(
  "makes known optout controls reachable for %s without a send form",
  (role) => {
    state.user = { role, actualRole: role, previewRole: null };
    state.useOperation.mockReturnValue({
      data: preference,
      refetch: state.refetch,
    });
    render(<TextPreferences />);
    lookup();
    expect(
      screen.getAllByText(preference.permission.reason).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Record opt-out for +18655550123" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Owner evidence review")).not.toBeInTheDocument();
    expect(state.operation).not.toHaveBeenCalled();
  },
);
it("hides old recipient evidence immediately when the lookup number is edited", () => {
  state.useOperation.mockReturnValue({
    data: preference,
    refetch: state.refetch,
  });
  render(<TextPreferences />);
  lookup();
  expect(screen.getByText("Text preference and evidence")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Recipient phone number"), {
    target: { value: "8655559999" },
  });
  expect(
    screen.queryByText("Text preference and evidence"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Record opt-out/ }),
  ).not.toBeInTheDocument();
});
it("hides cached permission after a failed refresh and offers a read-only retry", () => {
  state.useOperation.mockReturnValue({
    data: preference,
    isError: true,
    refetch: state.refetch,
  });
  render(<TextPreferences />);
  lookup();
  expect(screen.getByRole("alert")).toHaveTextContent("could not be confirmed");
  expect(
    screen.queryByText("Text preference and evidence"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh preference" }));
  expect(state.refetch).toHaveBeenCalledOnce();
  expect(state.operation).not.toHaveBeenCalled();
});
it("rejects malformed recipients without querying the supplied text", () => {
  render(<TextPreferences />);
  lookup("+18655550123?body=untrusted");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Enter a ten-digit US number",
  );
  expect(state.useOperation).toHaveBeenLastCalledWith(
    "/sms-preferences/recipient?to=",
    [],
  );
});
it("does not expose preference data or queries to installers", () => {
  state.user = {
    role: "installer",
    actualRole: "installer",
    previewRole: null,
  };
  state.useOperation.mockReturnValue({ data: preference });
  render(<TextPreferences />);
  expect(
    screen.getByText("Text preferences are available to office staff only."),
  ).toBeVisible();
  expect(
    screen.queryByLabelText("Recipient phone number"),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(preference.to)).not.toBeInTheDocument();
  expect(state.useOperation).toHaveBeenLastCalledWith(
    "/sms-preferences/recipient?to=",
    [],
  );
});
it("keeps owner role preview explicitly read-only", () => {
  state.user = {
    role: "operations",
    actualRole: "owner",
    previewRole: "operations",
  };
  state.useOperation.mockReturnValue({
    data: preference,
    refetch: state.refetch,
  });
  render(<TextPreferences />);
  lookup();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Role preview is read-only",
  );
  expect(
    screen.queryByRole("button", { name: /Record opt-out/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Owner evidence review")).not.toBeInTheDocument();
});
