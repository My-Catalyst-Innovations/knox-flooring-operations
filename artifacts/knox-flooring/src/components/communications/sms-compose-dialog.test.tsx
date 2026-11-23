import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SmsComposeDialog } from "./sms-compose-dialog";

const { toast, useOperation } = vi.hoisted(() => ({ toast: vi.fn(), useOperation: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/operations", () => ({ useOperation }));

const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, "share");
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setCapability(key: "share" | "clipboard", value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true });
}

beforeEach(() => {
  setCapability("share", undefined);
  setCapability("clipboard", undefined);
  useOperation.mockReturnValue({ data: undefined });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  for (const [key, descriptor] of [["share", shareDescriptor], ["clipboard", clipboardDescriptor]] as const) {
    if (descriptor) Object.defineProperty(navigator, key, descriptor);
    else Reflect.deleteProperty(navigator, key);
  }
});

function composer(onSend = vi.fn(), defaultBody = "A synthetic quote is ready. https://works.example.test/q/example") {
  return render(<SmsComposeDialog open onOpenChange={vi.fn()} toNumber="(865) 555-0123" customerName="Test customer" defaultBody={defaultBody} onSend={onSend} />);
}

it("shares a prepared message with the device without submitting it to Catalyst Works", async () => {
  const share = vi.fn().mockResolvedValue(undefined);
  const onSend = vi.fn();
  setCapability("share", share);
  composer(onSend, "Your synthetic order is ready.");

  expect(screen.getByRole("link", { name: "Open Messages" })).toHaveAttribute("href", "sms:+18655550123");
  fireEvent.click(screen.getByRole("button", { name: "Share from device" }));

  expect(await screen.findByRole("status")).toHaveTextContent("Check the recipient there before sending");
  expect(share).toHaveBeenCalledExactlyOnceWith({ text: "Your synthetic order is ready." });
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Send from company number" })).not.toBeInTheDocument();
  expect(toast).not.toHaveBeenCalled();
});

it("keeps the message available when sharing is cancelled or clipboard access is denied", async () => {
  const share = vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError"));
  const writeText = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
  setCapability("share", share);
  setCapability("clipboard", { writeText });
  composer();

  fireEvent.click(screen.getByRole("button", { name: "Share from device" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Share from device" })).toBeEnabled());
  expect(screen.queryByRole("status")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Copy the selected text");
  const message = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  expect(message).toHaveFocus();
  expect(message.selectionStart).toBe(0);
  expect(message.selectionEnd).toBe(message.value.length);
});

it("offers an addressed Messages link and copy when browser sharing is unavailable", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  setCapability("clipboard", { writeText });
  composer(undefined, "Quote link with punctuation ? # &");

  expect(screen.queryByRole("button", { name: "Share from device" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "To" }), { target: { value: "+18655550123?body=Injected" } });
  expect(screen.queryByRole("link", { name: "Open Messages" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "To" }), { target: { value: "+44 20 7946 0958" } });
  expect(screen.getByRole("link", { name: "Open Messages" })).toHaveAttribute("href", "sms:+442079460958");

  fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Message copied");
  expect(writeText).toHaveBeenCalledExactlyOnceWith("Quote link with punctuation ? # &");
});

it("makes an enabled company test send an explicit action and retains an unconfirmed attempt", async () => {
  useOperation.mockReturnValue({ data: { serverSendAvailable: true, mode: "allowlist" } });
  const onSend = vi.fn().mockResolvedValue({ status: "unknown" });
  composer(onSend, "Internal test");

  expect(screen.getByText("Only approved test numbers receive texts.")).toBeVisible();
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Submit company test" }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Submission unconfirmed" })));
  expect(screen.getByRole("dialog", { name: "Compose text" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Submit company test" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
  expect(onSend.mock.calls[0][0]).toMatchObject({ to: "+18655550123", body: "Internal test", idempotencyKey: expect.any(String) });
  expect(onSend.mock.calls[0][0]).toEqual(onSend.mock.calls[1][0]);
});

it("does not surface a company action for device-only forms or capture mode", () => {
  useOperation.mockReturnValue({ data: { serverSendAvailable: true, mode: "capture" } });
  const existing = composer();
  expect(screen.queryByRole("button", { name: "Send from company number" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Submit company test" })).not.toBeInTheDocument();
  existing.unmount();

  useOperation.mockReturnValue({ data: { serverSendAvailable: true, mode: "live" } });
  render(<SmsComposeDialog open onOpenChange={vi.fn()} toNumber="8655550123" defaultBody="Your portal is ready." />);
  expect(screen.queryByRole("button", { name: "Send from company number" })).not.toBeInTheDocument();
  expect(useOperation).toHaveBeenLastCalledWith("/communications/sms/status", []);
});

it.each([
  ["capture", "Company texting is paused. Ask your administrator to enable SMS testing or delivery; device sharing is available."],
  ["allowlist", "Company texting needs at least one approved test number. Ask your administrator to set the SMS test list."],
  ["live", "Company texting needs provider setup and an approved sender. Device sharing is available."],
])("explains gated company texting in %s mode while keeping device actions available",(mode,detail)=>{
  useOperation.mockReturnValue({data:{serverSendAvailable:false,mode,detail}});
  const onSend=vi.fn();composer(onSend);
  expect(screen.getByText(detail)).toBeVisible();
  expect(screen.getByRole("link",{name:"Open Messages"})).toBeVisible();
  expect(screen.getByRole("button",{name:"Copy message"})).toBeEnabled();
  expect(screen.queryByRole("button",{name:"Submit company test"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"Send from company number"})).not.toBeInTheDocument();
  expect(onSend).not.toHaveBeenCalled();
});
