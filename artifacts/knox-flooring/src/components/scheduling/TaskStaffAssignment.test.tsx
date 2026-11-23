import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStaffAssignment } from "./TaskStaffAssignment";
const mocks = vi.hoisted(() => ({
  user: { role: "operations", previewRole: null as string | null },
  operation: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/operations", () => ({
  operation: mocks.operation,
  useOperation: (path: string, roles: string[]) => ({
    allowed: roles.length > 0,
    isError: false,
    refetch: mocks.refetch,
    data:
      roles.length === 0
        ? undefined
        : path === "/tasks/assignees"
          ? [{ id: "sam", name: "Sam Installer", role: "installer" }]
          : {
              taskId: "task-1",
              bookingId: "booking-1",
              assigneeId: null,
              updatedAt: "saved-revision",
              bookingRevision: 3,
            },
  }),
}));
describe("installation staff assignment", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.role = "operations";
    mocks.user.previewRole = null;
    mocks.operation.mockResolvedValue({});
  });
  it("uses only the explicit assignment endpoint and current optimistic versions", async () => {
    render(<TaskStaffAssignment taskId="task-1" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Assigned staff" }), {
      target: { value: "sam" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save staff assignment" }),
    );
    await waitFor(() =>
      expect(mocks.operation).toHaveBeenCalledWith(
        "/tasks/task-1/assignment",
        "PATCH",
        { assigneeId: "sam", updatedAt: "saved-revision", bookingRevision: 3 },
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "No calendar or message was sent",
    );
    expect(mocks.operation).toHaveBeenCalledTimes(1);
  });
  it("does not expose an assignment control during owner role preview", () => {
    mocks.user.previewRole = "operations";
    render(<TaskStaffAssignment taskId="task-1" />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
  it("does not expose office assignment to installers or sales", () => {
    mocks.user.role = "installer";
    const view = render(<TaskStaffAssignment taskId="task-1" />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    mocks.user.role = "sales";
    view.rerender(<TaskStaffAssignment taskId="task-1" />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
