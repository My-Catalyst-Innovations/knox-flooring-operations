import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SmsPreferencePanel, type SmsPreference } from "./sms-preference-panel";
const state = vi.hoisted(() => ({
  user: {
    role: "owner",
    actualRole: "owner",
    previewRole: null as string | null,
  },
  operation: vi.fn(),
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/operations", () => ({ operation: state.operation }));
const base: SmsPreference = {
  to: "+15005550006",
  revision: 0,
  binding: {
    fingerprint: "a".repeat(64),
    provider: "signalwire",
    sender: "+15005550007",
    companyLabel: "Fictional Company",
    projectLabel: "project ending1111",
  },
  permission: {
    status: "unknown",
    canSendLive: false,
    canDeviceShare: true,
    reason: "No evidence is recorded",
  },
  history: [],
  hasMore: false,
};
beforeEach(() => {
  state.user = { role: "owner", actualRole: "owner", previewRole: null };
  state.operation.mockReset().mockResolvedValue({});
});
afterEach(cleanup);
const show = (data = base, to = data.to) => {
  const view = render(
    <SmsPreferencePanel to={to} preference={data} onRefresh={vi.fn()} />,
  );
  const summary = screen.queryByText("Text preference and evidence");
  if (summary) fireEvent.click(summary);
  return view;
};
const note = () =>
  fireEvent.change(screen.getByLabelText("Evidence or opt-out note"), {
    target: { value: "Fictional evidence note for testing" },
  });
it("requires reviewed evidence and defaults to fictional without sending a text", async () => {
  show();
  note();
  fireEvent.change(
    screen.getByLabelText("When the recipient gave permission"),
    { target: { value: "2026-11-23T10:00:00" } },
  );
  expect(
    screen.getByRole("button", { name: "Record reviewed evidence" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed this evidence/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Record reviewed evidence" }),
  );
  await waitFor(() => expect(state.operation).toHaveBeenCalledOnce());
  expect(state.operation).toHaveBeenCalledWith(
    "/sms-preferences/consent",
    "POST",
    expect.objectContaining({
      to: base.to,
      bindingFingerprint: base.binding!.fingerprint,
      releaseSuppression: false,
      evidence: expect.objectContaining({ synthetic: true, source: "written" }),
    }),
  );
  expect(state.operation.mock.calls[0][0]).not.toContain("/communications/sms");
});
it.each(["sales", "operations"])(
  "allows %s optout but hides owner-positive controls",
  async (role) => {
    state.user = { role, actualRole: role, previewRole: null };
    show();
    note();
    expect(screen.queryByText("Owner evidence review")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Record opt-out for +15005550006" }),
    );
    await waitFor(() =>
      expect(state.operation).toHaveBeenCalledWith(
        "/sms-preferences/suppress",
        "POST",
        expect.objectContaining({ to: base.to, revision: 0 }),
      ),
    );
  },
);
it("does not offer positive or negative mutations in owner role preview", () => {
  state.user = { role: "sales", actualRole: "owner", previewRole: "sales" };
  show();
  expect(
    screen.queryByRole("button", { name: /Record opt-out/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Owner evidence review")).not.toBeInTheDocument();
});
it("never silently releases suppression and disallows test evidence for release", () => {
  show({
    ...base,
    permission: {
      ...base.permission,
      status: "suppressed",
      canDeviceShare: false,
    },
  });
  const release = screen.getByRole("checkbox", {
    name: /Explicitly release this opt-out/,
  });
  expect(release).toBeDisabled();
  expect(release).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: /This is fictional/ }));
  expect(release).toBeEnabled();
  expect(release).not.toBeChecked();
});
it("clears approval when revision or sender changes and ignores stale recipient data", () => {
  const view = show();
  note();
  fireEvent.change(
    screen.getByLabelText("When the recipient gave permission"),
    { target: { value: "2026-11-23T10:00:00" } },
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed this evidence/ }),
  );
  expect(
    screen.getByRole("button", { name: "Record reviewed evidence" }),
  ).toBeEnabled();
  view.rerender(
    <SmsPreferencePanel
      to={base.to}
      preference={{ ...base, revision: 1 }}
      onRefresh={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Record reviewed evidence" }),
  ).toBeDisabled();
  view.rerender(
    <SmsPreferencePanel
      to="+15005550009"
      preference={base}
      onRefresh={vi.fn()}
    />,
  );
  expect(
    screen.queryByText("Text preference and evidence"),
  ).not.toBeInTheDocument();
});

it("keeps the same immutable request key after a lost save response", async () => {
  state.operation
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockResolvedValueOnce({});
  show();
  note();
  fireEvent.change(
    screen.getByLabelText("When the recipient gave permission"),
    { target: { value: "2026-11-23T10:00:00" } },
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed this evidence/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Record reviewed evidence" }),
  );
  await screen.findByText("Response lost");
  fireEvent.click(
    screen.getByRole("button", { name: "Record reviewed evidence" }),
  );
  await waitFor(() => expect(state.operation).toHaveBeenCalledTimes(2));
  expect(state.operation.mock.calls[0]).toEqual(state.operation.mock.calls[1]);
  expect(state.operation.mock.calls[0][2].requestKey).toEqual(
    expect.any(String),
  );
});

it("records explicit real renewed evidence and release only after separate owner confirmations", async () => {
  show({
    ...base,
    revision: 3,
    permission: {
      ...base.permission,
      status: "suppressed",
      canDeviceShare: false,
    },
  });
  note();
  fireEvent.change(
    screen.getByLabelText("When the recipient gave permission"),
    { target: { value: "2026-11-23T10:00:00" } },
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /This is fictional/ }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Explicitly release this opt-out/ }),
  );
  expect(
    screen.getByRole("button", { name: "Record reviewed evidence" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed this evidence/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Record reviewed evidence" }),
  );
  await waitFor(() => expect(state.operation).toHaveBeenCalledOnce());
  expect(state.operation).toHaveBeenCalledWith(
    "/sms-preferences/consent",
    "POST",
    expect.objectContaining({
      revision: 3,
      releaseSuppression: true,
      evidence: expect.objectContaining({
        synthetic: false,
        occurredAt: expect.stringMatching(/Z$/),
      }),
    }),
  );
});

it("clears positive approval on sender changes and cannot submit a future evidence time", () => {
  const view = show();
  note();
  fireEvent.change(
    screen.getByLabelText("When the recipient gave permission"),
    { target: { value: "2026-11-23T10:00:00" } },
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed this evidence/ }),
  );
  expect(
    screen.getByRole("button", { name: "Record reviewed evidence" }),
  ).toBeEnabled();
  view.rerender(
    <SmsPreferencePanel
      to={base.to}
      preference={{
        ...base,
        binding: { ...base.binding!, fingerprint: "b".repeat(64) },
      }}
      onRefresh={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Record reviewed evidence" }),
  ).toBeDisabled();
  fireEvent.change(
    screen.getByLabelText("When the recipient gave permission"),
    { target: { value: "2099-01-01T10:00:00" } },
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed this evidence/ }),
  );
  expect(
    screen.getByText("Enter a valid past time from 2000 onward."),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Record reviewed evidence" }),
  ).toBeDisabled();
  expect(state.operation).not.toHaveBeenCalled();
});

it("shows retained evidence source and reference as plain text without provider actions", () => {
  show({
    ...base,
    history: [
      {
        id: "event",
        kind: "evidence_recorded",
        recordedAt: "2026-11-23T15:00:00Z",
        occurredAt: "2026-11-23T14:00:00Z",
        note: "Retained operational permission",
        synthetic: false,
        releasedSuppression: false,
        bindingFingerprint: "b".repeat(64),
        evidence: {
          source: "written",
          reference: "<script>original reference</script>",
        },
      },
    ],
  });
  expect(screen.getByText("Source: Written permission")).toBeVisible();
  expect(
    screen.getByText("Reference: <script>original reference</script>"),
  ).toBeVisible();
  expect(
    screen.getByText("Evidence was recorded for an earlier sender connection."),
  ).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
  expect(state.operation).not.toHaveBeenCalled();
});

it("reports a saved preference separately from a failed status refresh", async () => {
  render(
    <SmsPreferencePanel
      to={base.to}
      preference={base}
      onRefresh={vi.fn().mockRejectedValue(new Error("offline"))}
    />,
  );
  fireEvent.click(screen.getByText("Text preference and evidence"));
  note();
  fireEvent.click(
    screen.getByRole("button", { name: `Record opt-out for ${base.to}` }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "was saved, but its latest status could not be loaded",
  );
  expect(state.operation).toHaveBeenCalledOnce();
});
