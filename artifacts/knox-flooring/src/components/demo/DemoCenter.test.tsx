import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoCenter } from "./DemoCenter";
import type { TrainingStatus } from "./training-types";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

const mocks = vi.hoisted(() => ({ api: vi.fn(), navigate: vi.fn(), switchPersona: vi.fn(), user: { role: "owner" as "owner" | "sales" | "operations" | "installer", actualRole: "owner" as "owner" | undefined, previewRole: null as null | "sales" } }));
vi.mock("@workspace/api-client-react", () => ({ customFetch: mocks.api }));
vi.mock("wouter", () => ({ useLocation: () => ["/", mocks.navigate] }));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: mocks.user, switchPersona: mocks.switchPersona }) }));

const preferences = { userId: "owner", voiceEnabled: false, captionsEnabled: true as const, welcomeDismissed: true };
const mission = {
  key: "executive", name: "Executive Tour", role: "owner" as const, minutes: 15, summary: "Lead to payment",
  steps: [{ id: "executive-dashboard", route: "/", target: "nav-dashboard", placement: "right" as const, kind: "info" as const, title: "Your command center", explanation: "Owner priorities", instruction: "Review this control", narration: "Welcome to the command center for this flooring business and its daily priorities.", seconds: 25 }],
};

function status(kind: "info" | "action" = "info"): TrainingStatus {
  return {
    enabled: true, practice: { enabled: true, url: null }, lessons: [], manifestVersion: "test", preferences, runs: [], pageGuides: [{ key: "dashboard", name: "Dashboard", route: "/", role: ["owner"], summary: "Daily priorities", target: "nav-dashboard", narration: "Dashboard help" }],
    narration: { provider: "ElevenLabs", voice: "Adam - Engaging, Friendly and Bright", model: "eleven_multilingual_v2" },
    missions: [{ ...mission, steps: [{ ...mission.steps[0], kind }] }],
  };
}

function installApi(kind: "info" | "action" = "info") {
  mocks.api.mockImplementation((path: string, options?: RequestInit) => {
    if (path === "/api/demo/status") return Promise.resolve(status(kind));
    if (path.endsWith("/start")) return Promise.resolve({ id: "run-1", userId: "owner", missionKey: "executive", manifestVersion: "test", status: "active", currentStep: 0, voiceEnabled: false, checkpoints: [], startedAt: "now", updatedAt: "now" });
    if (path.endsWith("/verify")) return Promise.resolve({ id: "run-1", userId: "owner", missionKey: "executive", manifestVersion: "test", status: "completed", currentStep: 0, voiceEnabled: false, checkpoints: ["executive-dashboard"], startedAt: "now", updatedAt: "now", complete: true });
    if (path === "/api/demo/preferences" && options?.method === "PUT") return Promise.resolve(preferences);
    throw new Error(`Unexpected request: ${path}`);
  });
}

function installAudio(fetchMock: ReturnType<typeof vi.fn>) {
  const play = vi.fn(() => Promise.resolve());
  const pause = vi.fn();
  const audio = vi.fn(function (this: { play: typeof play; pause: typeof pause }) { this.play = play; this.pause = pause; });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Audio", audio);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:training-audio");
    static revokeObjectURL = vi.fn();
  });
  return { audio, play, pause };
}

function narrationResponse(provider = "ElevenLabs", fallback = false) {
  return new Response(new Uint8Array([1, 2, 3]), { headers: {
    "Content-Type": "audio/mpeg",
    "X-Narration-Provider": provider,
    "X-Narration-Voice": provider === "ElevenLabs" ? "Selected teaching voice" : "marin",
    ...(fallback ? { "X-Narration-Fallback-Reason": "ElevenLabs is busy. Playing the backup voice; Replay tries ElevenLabs again." } : {}),
  } });
}

describe("DemoCenter", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.switchPersona.mockReset(); mocks.user.role = "owner"; mocks.user.actualRole = "owner"; mocks.user.previewRole = null; });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("opens from the persistent Training control and completes an informational step", async () => {
    installApi();
    render(<><button data-training-id="nav-dashboard">Dashboard</button><DemoCenter /></>);
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith("/api/demo/status", expect.anything()));
    fireEvent(window, new Event("knox:demo-center"));
    expect(await screen.findByText("Training Center")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /start silently/i }));
    expect(await screen.findByText("Your command center")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /complete mission/i }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(expect.stringMatching(/verify$/), expect.objectContaining({ method: "POST" })));
    expect(await screen.findByText("Training Center")).toBeInTheDocument();
  });

  it("asks the server to verify a saved practice record without supplying a client interaction result", async () => {
    installApi("action");
    render(<><button data-training-id="nav-dashboard">Save practice record</button><DemoCenter /></>);
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    fireEvent(window, new Event("knox:demo-center"));
    fireEvent.click(await screen.findByRole("button", { name: /start silently/i }));
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Save practice record" }));
    expect(await screen.findByText(/verification checks the saved practice record/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /verify & complete/i }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(expect.stringMatching(/verify$/), expect.objectContaining({
      body: JSON.stringify({ runId: "run-1", stepId: "executive-dashboard", skipped: false }),
    })));
  });

  it("shows live lesson outlines and links to separate practice without starting a mission", async () => {
    const training = status();
    mocks.api.mockResolvedValue({
      ...training, practice: { enabled: false, url: "https://practice.example.test" },
      missions: [], lessons: [mission],
    });
    render(<DemoCenter />);
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    fireEvent(window, new Event("knox:demo-center"));
    expect(await screen.findByText("Executive Tour")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open fictional practice workspace/i })).toHaveAttribute("href", "https://practice.example.test");
    expect(screen.queryByRole("button", { name: /start silently/i })).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("keeps a contextual Page Guide available outside missions", async () => {
    installApi();
    render(<><button data-training-id="nav-dashboard">Dashboard</button><DemoCenter /></>);
    fireEvent.click(await screen.findByRole("button", { name: /open dashboard page guide/i }));
    expect(await screen.findByText("Dashboard Page Guide")).toBeInTheDocument();
    expect(screen.getByText("Daily priorities")).toBeInTheDocument();
  });

  it("switches a password-free owner session into the sales perspective before starting sales training", async () => {
    mocks.user.actualRole = undefined;
    const salesMission = { ...mission, key: "sales", name: "Sales & Estimating Mission", role: "sales" as const };
    mocks.api.mockImplementation((path: string) => {
      if (path === "/api/demo/status") return Promise.resolve({ ...status(), missions: [salesMission] });
      if (path.endsWith("/start")) return Promise.resolve({ id: "run-sales", userId: "owner", missionKey: "sales", manifestVersion: "test", status: "active", currentStep: 0, voiceEnabled: false, checkpoints: [], startedAt: "now", updatedAt: "now" });
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<><button data-training-id="nav-dashboard">Dashboard</button><DemoCenter /></>);
    fireEvent(window, new Event("knox:demo-center"));
    fireEvent.click(await screen.findByRole("button", { name: /start silently/i }));
    await waitFor(() => expect(mocks.switchPersona).toHaveBeenCalledWith("sales"));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith("/api/demo/missions/sales/start", expect.objectContaining({ method: "POST" })));
  });

  it("retries the selected provider after backup narration without reusing a browser-cached fallback", async () => {
    installApi();
    const fetchMock = vi.fn().mockResolvedValueOnce(narrationResponse("OpenAI", true)).mockResolvedValueOnce(narrationResponse());
    const audio = installAudio(fetchMock);
    render(<><button data-training-id="nav-dashboard">Dashboard</button><DemoCenter /></>);
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    fireEvent(window, new Event("knox:demo-center"));
    fireEvent.click(await screen.findByRole("button", { name: /start with voice/i }));
    expect(await screen.findByRole("status")).toHaveTextContent("ElevenLabs is busy. Playing the backup voice; Replay tries ElevenLabs again.");
    await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(await screen.findByText(/ElevenLabs · Selected teaching voice/)).toBeInTheDocument();
    await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Playing the backup voice/i)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchMock.mock.calls) expect(options).toMatchObject({ cache: "no-store", credentials: "include", signal: expect.any(AbortSignal) });
  });

  it("cancels pending narration when muted and ignores a late response", async () => {
    installApi();
    let resolveAudio!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveAudio = resolve; }));
    const audio = installAudio(fetchMock);
    render(<><button data-training-id="nav-dashboard">Dashboard</button><DemoCenter /></>);
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    fireEvent(window, new Event("knox:demo-center"));
    fireEvent.click(await screen.findByRole("button", { name: /start with voice/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    fireEvent.click(await screen.findByRole("button", { name: "Mute narration" }));
    expect(request[1].signal?.aborted).toBe(true);
    await act(async () => { resolveAudio(narrationResponse("OpenAI", true)); });
    expect(audio.audio).not.toHaveBeenCalled();
    expect(screen.queryByText(/OpenAI backup narrator/)).not.toBeInTheDocument();
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument();
  });

  it("ignores narration from an old step and aborts its prefetch after advancing", async () => {
    const secondStep = { ...mission.steps[0], id: "executive-second", title: "Next lesson" };
    const training = status();
    training.missions[0].steps.push(secondStep);
    const run = { id: "run-1", userId: "owner", missionKey: "executive", manifestVersion: "test", status: "active", currentStep: 0, voiceEnabled: true, checkpoints: [], startedAt: "now", updatedAt: "now" };
    mocks.api.mockImplementation((path: string) => {
      if (path === "/api/demo/status") return Promise.resolve(training);
      if (path.endsWith("/start")) return Promise.resolve(run);
      if (path.endsWith("/verify")) return Promise.resolve({ ...run, currentStep: 1 });
      throw new Error(`Unexpected request: ${path}`);
    });
    const requests: Array<{ url: string; options: RequestInit; resolve: (response: Response) => void }> = [];
    const fetchMock = vi.fn((url: string, options: RequestInit) => new Promise<Response>((resolve) => { requests.push({ url, options, resolve }); }));
    const audio = installAudio(fetchMock);
    render(<><button data-training-id="nav-dashboard">Dashboard</button><DemoCenter /></>);
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    fireEvent(window, new Event("knox:demo-center"));
    fireEvent.click(await screen.findByRole("button", { name: /start with voice/i }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].url).toContain(secondStep.id);
    expect(requests[1].options.cache).toBe("no-store");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Next lesson")).toBeInTheDocument();
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[0].options.signal?.aborted).toBe(true);
    expect(requests[1].options.signal?.aborted).toBe(true);
    await act(async () => { requests[2].resolve(narrationResponse()); });
    await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    await act(async () => { requests[0].resolve(narrationResponse("OpenAI", true)); requests[1].resolve(narrationResponse()); });
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/ElevenLabs · Selected teaching voice/)).toBeInTheDocument();
    expect(screen.queryByText(/Playing the backup voice/i)).not.toBeInTheDocument();
  });
  it("offers explicit resume for an active mission from another perspective", async () => {
    const training = status();
    training.missions = [{ ...mission, key: "sales", name: "Sales mission", role: "sales" }];
    const run = { id: "other-role-run", userId: "owner", missionKey: "sales", manifestVersion: "test", status: "active" as const, currentStep: 0, voiceEnabled: false, checkpoints: [], startedAt: "now", updatedAt: "now" };
    training.runs = [run];
    mocks.switchPersona.mockImplementation(async () => { mocks.user.role = "sales"; mocks.user.previewRole = "sales"; });
    mocks.api.mockImplementation((path: string) => {
      if (path === "/api/demo/status") return Promise.resolve(training);
      if (path === "/api/demo/missions/sales") return Promise.resolve(run);
      throw new Error("Unexpected request: " + path);
    });
    render(<><button data-training-id="nav-dashboard">Dashboard</button><DemoCenter /></>);
    await screen.findByRole("button", { name: /open dashboard page guide/i });
    expect(screen.queryByText("Your command center")).not.toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
    fireEvent(window, new Event("knox:demo-center"));
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mocks.switchPersona).toHaveBeenCalledWith("sales"));
    expect(await screen.findByText("Your command center")).toBeInTheDocument();
  });

  it("hides an active lesson immediately after switching away from its role", async () => {
    installApi();
    const view = render(<><button data-training-id="nav-dashboard">Dashboard</button><DemoCenter /></>);
    fireEvent(window, new Event("knox:demo-center"));
    fireEvent.click(await screen.findByRole("button", { name: /start silently/i }));
    expect(await screen.findByText("Your command center")).toBeInTheDocument();
    mocks.user.role = "operations";
    view.rerender(<><button data-training-id="nav-dashboard">Dashboard</button><DemoCenter /></>);
    await waitFor(() => expect(screen.queryByText("Your command center")).not.toBeInTheDocument());
  });

  it("lets business dialogs own focus and Escape while training stays paused visually", async () => {
    installApi();
    const content = (open: boolean) => <><button data-training-id="nav-dashboard">Dashboard</button><DemoCenter /><Dialog open={open}><DialogContent><DialogTitle>Record receipt</DialogTitle><DialogDescription>Save the actual delivery.</DialogDescription><input aria-label="Received boxes" /></DialogContent></Dialog></>;
    const view = render(content(false));
    fireEvent(window, new Event("knox:demo-center"));
    fireEvent.click(await screen.findByRole("button", { name: /start silently/i }));
    expect(await screen.findByText("Your command center")).toBeInTheDocument();
    view.rerender(content(true));
    await waitFor(() => expect(document.querySelector('aside[aria-labelledby="training-step-title"]')).toBeNull());
    expect(screen.getByRole("dialog", { name: "Record receipt" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Received boxes"), { key: "Escape" });
    expect(mocks.api.mock.calls.some(([path]) => String(path).endsWith("/exit"))).toBe(false);
    view.rerender(content(false));
    expect(await screen.findByText("Your command center")).toBeInTheDocument();
  });

  it("leaves Escape with a newly opened business dialog before its observer runs", async () => {
    installApi();
    render(<><button data-training-id="nav-dashboard">Dashboard</button><DemoCenter /></>);
    fireEvent(window, new Event("knox:demo-center"));
    fireEvent.click(await screen.findByRole("button", { name: /start silently/i }));
    expect(await screen.findByRole("dialog", { name: "Your command center" })).toBeInTheDocument();
    const businessDialog = document.createElement("div");
    businessDialog.setAttribute("role", "dialog");
    businessDialog.setAttribute("data-state", "open");
    const input = document.createElement("input");
    businessDialog.append(input);
    try {
      act(() => {
        // The first keystroke may arrive before MutationObserver updates React.
        document.body.append(businessDialog);
        fireEvent.keyDown(input, { key: "Escape" });
      });
      expect(mocks.api.mock.calls.some(([path]) => String(path).endsWith("/exit"))).toBe(false);
    } finally {
      act(() => businessDialog.remove());
    }
  });

  it("labels skipped completion without claiming verified practice", async () => {
    const training = status();
    training.runs = [{ id: "skipped-run", userId: "owner", missionKey: "executive", manifestVersion: "test", status: "completed", currentStep: 0, voiceEnabled: false, checkpoints: ["executive-dashboard:skipped"], startedAt: "now", updatedAt: "now" }];
    mocks.api.mockResolvedValue(training);
    render(<DemoCenter />);
    fireEvent(window, new Event("knox:demo-center"));
    expect(await screen.findByText("Finished with skipped steps — restart to practice")).toBeInTheDocument();
    expect(screen.queryByText("Completed and verified")).not.toBeInTheDocument();
  });

  it("shows the title at the top when advancing a scrolled training panel", async () => {
    const training = status();
    training.missions[0].steps.push({ ...mission.steps[0], id: "next-step", title: "Next step heading" });
    const run = { id: "run-1", userId: "owner", missionKey: "executive", manifestVersion: "test", status: "active", currentStep: 0, voiceEnabled: false, checkpoints: [], startedAt: "now", updatedAt: "now" };
    mocks.api.mockImplementation((path: string) => {
      if (path === "/api/demo/status") return Promise.resolve(training);
      if (path.endsWith("/start")) return Promise.resolve(run);
      if (path.endsWith("/verify")) return Promise.resolve({ ...run, currentStep: 1 });
      throw new Error("Unexpected request: " + path);
    });
    render(<><button data-training-id="nav-dashboard">Dashboard</button><DemoCenter /></>);
    fireEvent(window, new Event("knox:demo-center"));
    fireEvent.click(await screen.findByRole("button", { name: /start silently/i }));
    const panel = await screen.findByRole("dialog", { name: "Your command center" });
    panel.scrollTop = 250;
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const nextPanel = await screen.findByRole("dialog", { name: "Next step heading" });
    expect(nextPanel.scrollTop).toBe(0);
  });

});
