import { expect, it } from "vitest";
import { communicationStatus } from "./communication-status";

it("distinguishes demo captures, provider submission, and delivery", () => {
  expect(
    communicationStatus({ status: "sent", providerMessageId: "demo:123" }),
  ).toBe("Captured in demo");
  expect(communicationStatus({ status: "captured" })).toBe("Captured in demo");
  expect(communicationStatus({ status: "queued" })).toBe("Submission pending");
  expect(
    communicationStatus({
      status: "queued",
      providerMessageId: "provider-123",
    }),
  ).toBe("Queued by provider");
  expect(
    communicationStatus({ status: "sent", providerMessageId: "provider-123" }),
  ).toBe("Submitted to provider");
  expect(
    communicationStatus({
      status: "delivered",
      providerMessageId: "provider-123",
    }),
  ).toBe("Delivered");
  expect(communicationStatus({ status: "unknown" })).toBe(
    "Submission unconfirmed",
  );
  expect(communicationStatus({ status: "failed" })).toBe("Failed");
});
