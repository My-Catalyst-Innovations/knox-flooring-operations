import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JobUpdates } from "./JobUpdates";

const tests = vi.hoisted(() => ({ operation: vi.fn(), refetch: vi.fn() }));
vi.mock("@/lib/operations", () => ({ operation: tests.operation, useOperation: () => ({ data: [], refetch: tests.refetch }) }));
afterEach(cleanup);

it("retains input and the same request identifier after an interrupted save", async () => {
  tests.operation.mockRejectedValueOnce(new Error("Connection interrupted")).mockResolvedValueOnce({});
  render(<JobUpdates jobId="job-1" />);
  const input = screen.getByLabelText("Quick update");
  fireEvent.change(input, { target: { value: "Bring spare transition strips" } });
  fireEvent.click(screen.getByRole("button", { name: "Save update" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
  expect(input).toHaveValue("Bring spare transition strips");

  fireEvent.click(screen.getByRole("button", { name: "Save update" }));
  expect(await screen.findByText("Update saved for your team.")).toBeVisible();
  expect(tests.operation).toHaveBeenCalledTimes(2);
  expect(tests.operation.mock.calls[0]).toEqual(tests.operation.mock.calls[1]);
  expect(input).toHaveValue("");
});
