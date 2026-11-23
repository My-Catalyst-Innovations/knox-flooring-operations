import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CameraScanButton } from "./CameraScanButton";

const fixture = vi.hoisted(() => ({ decode: vi.fn(), stop: vi.fn() }));
vi.mock("@zxing/browser", () => ({ BrowserMultiFormatReader: class { decodeFromConstraints = fixture.decode; } }));
beforeEach(() => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
  fixture.decode.mockResolvedValue({ stop: fixture.stop });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("opens a local video camera only after a click and returns one decoded label", async () => {
  const scan = vi.fn();
  render(<CameraScanButton onScan={scan} />);
  expect(fixture.decode).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
  await waitFor(() => expect(fixture.decode).toHaveBeenCalledOnce());
  expect(fixture.decode.mock.calls[0][0]).toEqual({ audio: false, video: { facingMode: { ideal: "environment" } } });
  const decoded = fixture.decode.mock.calls[0][2];
  act(() => { decoded({ getText: () => "000001" }, undefined, { stop: fixture.stop }); decoded({ getText: () => "DUPLICATE" }, undefined, { stop: fixture.stop }); });
  expect(scan).toHaveBeenCalledExactlyOnceWith("000001");
  expect(fixture.stop).toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("stops a permission request that finishes after the dialog was closed", async () => {
  let ready!: (value: { stop: typeof fixture.stop }) => void;
  fixture.decode.mockReturnValue(new Promise(resolve => { ready = resolve; }));
  const scan = vi.fn();
  render(<CameraScanButton onScan={scan} />);
  fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
  await waitFor(() => expect(fixture.decode).toHaveBeenCalledOnce());
  const decoded = fixture.decode.mock.calls[0][2];
  fireEvent.click(screen.getByRole("button", { name: "Cancel scan" }));
  await act(async () => { ready({ stop: fixture.stop }); });
  expect(fixture.stop).toHaveBeenCalled();
  act(() => decoded({ getText: () => "LATE" }, undefined, { stop: fixture.stop }));
  expect(scan).not.toHaveBeenCalled();
});

it("keeps manual entry available when camera permission is denied", async () => {
  fixture.decode.mockRejectedValue(new DOMException("No permission", "NotAllowedError"));
  const scan = vi.fn();
  render(<CameraScanButton onScan={scan} />);
  fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Camera access was not allowed");
  expect(scan).not.toHaveBeenCalled();
});

it("does not submit invalid or oversized barcode content", async () => {
  const scan = vi.fn();
  render(<CameraScanButton onScan={scan} maxLength={10} />);
  fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
  await waitFor(() => expect(fixture.decode).toHaveBeenCalledOnce());
  const decoded = fixture.decode.mock.calls[0][2];
  act(() => decoded({ getText: () => "ABC\nDEF" }, undefined, { stop: fixture.stop }));
  expect(screen.getByRole("alert")).toBeVisible();
  expect(scan).not.toHaveBeenCalled();
  act(() => decoded({ getText: () => "TOO-LONG-BARCODE" }, undefined, { stop: fixture.stop }));
  expect(scan).not.toHaveBeenCalled();
});
