import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EmailComposeDialog } from "./email-compose-dialog";

const { toast, operation } = vi.hoisted(() => ({ toast: vi.fn(), operation: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/operations", () => ({ operation }));

beforeEach(() => {
  operation.mockResolvedValue({
    outlook: { connected: true, mailboxEmail: "owner@example.test" },
    resend: { configured: true },
    mode: "allowlist",
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function composer(onSend = vi.fn(), onOpenChange = vi.fn()) {
  render(<EmailComposeDialog open onOpenChange={onOpenChange} toAddress="owner@example.test" defaultSubject="Internal verification" defaultBody="Fictional customer message." onSend={onSend} />);
  return { onSend, onOpenChange };
}

it("keeps the company sender as the default and requires explicit Outlook selection", async () => {
  const onSend = vi.fn().mockResolvedValue({ status: "sent", emailProvider: "outlook", providerMessageId: null });
  const { onOpenChange } = composer(onSend);
  const sender = screen.getByRole("combobox", { name: "Send using" });
  expect(sender).toHaveValue("resend");
  await waitFor(() => expect(screen.getByRole("option", { name: "Outlook · owner@example.test" })).toBeEnabled());
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.change(sender, { target: { value: "outlook" } });
  expect(screen.getByText(/delivery is not confirmed here/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Send Email" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    to: "owner@example.test", provider: "outlook", idempotencyKey: expect.any(String),
  })));
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Submitted to Outlook" }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("disables the Microsoft sender when mailbox consent is absent or status cannot be checked", async () => {
  operation.mockResolvedValue({ outlook: { connected: false, mailboxEmail: null }, resend: { configured: true }, mode: "live" });
  const { onSend } = composer();
  await waitFor(() => expect(operation).toHaveBeenCalledWith("/communications/email/status"));
  expect(screen.getByRole("option", { name: "Connected Outlook mailbox" })).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Send using" }), { target: { value: "outlook" } });
  expect(screen.getByRole("button", { name: "Send Email" })).toBeDisabled();
  expect(onSend).not.toHaveBeenCalled();
});

it("retains the original request key and open composer after an ambiguous Outlook submission", async () => {
  const onSend = vi.fn().mockResolvedValue({ status: "unknown", emailProvider: "outlook", providerMessageId: null, errorMessage: "Check Outlook Sent Items before trying a new message." });
  const { onOpenChange } = composer(onSend);
  await waitFor(() => expect(screen.getByRole("option", { name: "Outlook · owner@example.test" })).toBeEnabled());
  fireEvent.change(screen.getByRole("combobox", { name: "Send using" }), { target: { value: "outlook" } });
  fireEvent.click(screen.getByRole("button", { name: "Send Email" }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Submission unconfirmed" })));
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Compose Email" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Send Email" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
  expect(onSend.mock.calls[0][0]).toEqual(onSend.mock.calls[1][0]);
});
