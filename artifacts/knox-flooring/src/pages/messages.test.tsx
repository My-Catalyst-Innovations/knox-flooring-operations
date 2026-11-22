import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Messages from "./messages";

const mocks = vi.hoisted(() => ({ reply: vi.fn(), refetch: vi.fn() }));
vi.mock("@/lib/operations", () => ({ useOperation: () => ({
  refetch: mocks.refetch, isLoading: false, isError: false,
  data: [
    { id: "unknown", channel: "sms", direction: "inbound", status: "received", fromAddress: "+18655550111", toAddress: "+18655550222", body: "Please call about the delivery", createdAt: "2026-11-22T12:00:00Z" },
    { id: "linked", channel: "sms", direction: "outbound", status: "failed", leadId: "lead-a", customerName: "A customer", fromAddress: "+18655550222", toAddress: "+18655550333", body: "Your estimate", createdAt: "2026-11-22T11:00:00Z" },
  ],
}) }));
vi.mock("@/hooks/use-store", () => ({ useCommunications: () => ({ sendSms: mocks.reply }) }));
vi.mock("@/components/communications", () => ({
  CommunicationsHistory: ({ communications }: { communications: Array<{ body: string }> }) => <p>{communications[0].body}</p>,
  SmsComposeDialog: ({ open, toNumber }: { open: boolean; toNumber: string }) => open && <div role="dialog">Text {toNumber}</div>,
}));
afterEach(cleanup);
it("keeps unassigned inbound replies visible and addresses a response to their sender", () => {
  render(<Messages />);
  fireEvent.change(screen.getByLabelText("Message filter"), { target: { value: "unassigned" } });
  expect(screen.getByText("Please call about the delivery")).toBeTruthy();
  expect(screen.queryByText("Your estimate")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Compose text" }));
  expect(screen.getByRole("dialog").textContent).toContain("+18655550111");
  expect(mocks.reply).not.toHaveBeenCalled();
});
