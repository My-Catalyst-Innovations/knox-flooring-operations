import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  getListJobsQueryKey,
  getListLeadsQueryKey,
} from "@workspace/api-client-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import type { Lead } from "@/lib/types";
import LeadDetail from "./lead-detail";
import Leads from "./leads";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  addJob: vi.fn(),
  updateLead: vi.fn(),
  toast: vi.fn(),
}));

const lead: Lead = {
  id: "lead-1",
  revision: 7,
  customerName: "Sample contact",
  phone: "",
  email: "",
  address: "",
  city: "Knoxville",
  flooringInterest: "Hardwood",
  estimatedValue: 500,
  source: "Referral",
  stage: "New",
  salesperson: "",
  activityLog: [],
  notes: "",
  createdAt: "2026-11-19T12:00:00Z",
  updatedAt: "2026-11-19T12:00:00Z",
};

vi.mock("@/hooks/use-store", () => ({
  useStore: () => ({
    leads: [lead],
    jobs: [],
    settings: {},
    addJob: mocks.addJob,
    updateLead: mocks.updateLead,
    queryState: {
      leads: { data: [lead], isLoading: false, isError: false, error: null },
    },
  }),
}));
vi.mock("@/hooks/use-create-context", () => ({
  useCreateContext: () => ({ loading: false, key: "", found: false }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("@/components/leads/lead-tabs", () => ({ LeadTabs: () => null }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("lead conversion entry points", () => {
  it("uses a single revision-aware conversion from lead details and refreshes both lists before opening the job", async () => {
    window.history.replaceState({}, "", "/leads/lead-1");
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    let finishRequest!: (response: Response) => void;
    mocks.fetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        finishRequest = resolve;
      }),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <Route path="/leads/:id" component={LeadDetail} />
      </QueryClientProvider>,
    );

    const convert = screen.getByRole("button", { name: "Win & Convert" });
    act(() => {
      convert.click();
      convert.click();
    });
    expect(
      await screen.findByRole("button", { name: "Converting…" }),
    ).toBeDisabled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/leads/lead-1/convert",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ revision: 7 }),
      }),
    );
    expect(mocks.addJob).not.toHaveBeenCalled();
    expect(mocks.updateLead).not.toHaveBeenCalled();

    finishRequest(Response.json({ id: "job-1", jobNumber: "KF-100" }));
    await waitFor(() => expect(window.location.pathname).toBe("/jobs/job-1"));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: getListJobsQueryKey(),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: getListLeadsQueryKey(),
    });
  });

  it("uses the same conversion from the Won column and reports a rejected request", async () => {
    window.history.replaceState({}, "", "/leads?view=board");
    mocks.fetch.mockResolvedValueOnce(
      Response.json(
        { error: "This record changed. Refresh before saving." },
        { status: 409 },
      ),
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <Leads />
      </QueryClientProvider>,
    );

    const card = screen
      .getByRole("link", { name: lead.customerName })
      .closest("[draggable]");
    expect(card).not.toBeNull();
    fireEvent.dragStart(card!);
    fireEvent.drop(screen.getByRole("group", { name: "Won stage" }));

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Lead conversion failed",
          variant: "destructive",
          description: expect.stringContaining("This record changed"),
        }),
      ),
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/leads/lead-1/convert",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ revision: 7 }),
      }),
    );
    expect(card).toHaveAttribute("draggable", "true");
    expect(mocks.addJob).not.toHaveBeenCalled();
    expect(mocks.updateLead).not.toHaveBeenCalled();
  });
});
