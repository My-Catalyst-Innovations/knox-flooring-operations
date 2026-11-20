import { expect, it } from "vitest";
import { communicationStatus } from "./communication-status";

it("distinguishes demo captures, provider submission, and delivery", () => {
  expect(communicationStatus({ status: "sent", providerMessageId: "demo:123" })).toBe("Captured in demo");
  expect(communicationStatus({ status: "sent", providerMessageId: "provider-123" })).toBe("Submitted to provider");
  expect(communicationStatus({ status: "delivered", providerMessageId: "provider-123" })).toBe("Delivered");
});
