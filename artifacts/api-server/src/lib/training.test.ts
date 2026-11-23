import { describe, expect, it } from "vitest";
import { PAGE_GUIDES, TRAINING_MISSIONS, canCompleteTrainingStep, findTrainingStep } from "./training";
import { hasMeasuredRoom, practiceCustomerName, trainingPracticeAccess } from "./training-practice";

describe("training manifest", () => {
  it("covers every primary application page with contextual help", () => {
    expect(PAGE_GUIDES).toHaveLength(20);
    expect(PAGE_GUIDES.map((guide) => guide.key)).toEqual(expect.arrayContaining([
      "dashboard", "ai-operations", "leads", "pipeline", "estimator", "proposals", "jobs", "schedule", "calendar", "tasks",
      "materials", "inventory", "invoices", "commissions", "sales", "customers", "reports", "settings", "integration-health", "demo-outbox",
    ]));
  });

  it("defines five restartable missions with unique, allowlisted narration", () => {
    expect(TRAINING_MISSIONS.map((mission) => mission.key)).toEqual(["executive", "owner", "sales", "operations", "installer"]);
    const steps = TRAINING_MISSIONS.flatMap((mission) => mission.steps);
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
    for (const step of steps) {
      expect(step.route).not.toBe("/jobs/4");
      expect(Boolean(step.outcome)).toBe(step.kind === "action");
      expect(step.narration.length).toBeGreaterThan(50);
      expect(step.seconds).toBeGreaterThanOrEqual(20);
      expect(step.seconds).toBeLessThanOrEqual(40);
      expect(findTrainingStep(step.id)?.step.narration).toBe(step.narration);
    }
    expect(findTrainingStep("unregistered-user-speech")).toBeNull();
    expect(findTrainingStep("guide-dashboard")?.step.narration).toBe(PAGE_GUIDES[0].narration);
  });

  it("does not falsely complete an action checkpoint", () => {
    expect(canCompleteTrainingStep({ kind: "action" }, false)).toBe(false);
    expect(canCompleteTrainingStep({ kind: "action" }, true)).toBe(true);
    expect(canCompleteTrainingStep({ kind: "action" }, false, true)).toBe(true);
    expect(canCompleteTrainingStep({ kind: "info" }, false)).toBe(true);
  });
});

describe("training practice access", () => {
  const url = "https://practice.example.test";
  const host = "practice.example.test";
  const env = {
    PRACTICE_WORKSPACE_URL: url, APP_BASE_URL: url, DEMO_MODE: "true",
    BACKGROUND_WORKERS_ENABLED: "false", COMMS_DELIVERY_MODE: "capture",
  };

  it("enables exercises only for the explicit dedicated hostname without business connections", () => {
    expect(trainingPracticeAccess(env, host, true)).toEqual({ enabled: true, url: null });
    expect(trainingPracticeAccess(env, host, false).enabled).toBe(false);
    expect(trainingPracticeAccess({ ...env, DEMO_MODE: "false" }, host, true).enabled).toBe(false);
    expect(trainingPracticeAccess({ ...env, DEMO_ACCESS_ENABLED: "true" }, host, true).enabled).toBe(false);
    expect(trainingPracticeAccess({ ...env, RESEND_API_KEY: "placeholder" }, host, true).enabled).toBe(false);
    expect(trainingPracticeAccess({ ...env, MEASURE_SQUARE_API_KEY: "placeholder" }, host, true).enabled).toBe(false);
    expect(trainingPracticeAccess({ ...env, COMMS_DELIVERY_MODE: "live" }, host, true).enabled).toBe(false);
    expect(trainingPracticeAccess({ ...env, APP_BASE_URL: "https://live.example.test" }, "live.example.test", true)).toEqual({ enabled: false, url });
    expect(trainingPracticeAccess({ ...env, PRACTICE_WORKSPACE_URL: "https://user:password@practice.example.test/" }, host, true)).toEqual({ enabled: false, url: null });
  });

  it("distinguishes new runs and validates saved positive measurements", () => {
    expect(practiceCustomerName({ id: "run-one", startedAt: "2026-11-23T12:00:00.000Z" })).not.toBe(practiceCustomerName({ id: "run-one", startedAt: "2026-11-23T12:00:01.000Z" }));
    expect(hasMeasuredRoom({ rooms: [{ length: 10, width: 0 }] })).toBe(false);
    expect(hasMeasuredRoom({ rooms: [{ length: 10, width: 12 }] })).toBe(true);
  });

  it.each([
    "MICROSOFT_FILES_CLIENT_ID",
    "MICROSOFT_FILES_CLIENT_SECRET",
    "MICROSOFT_FILES_ENCRYPTION_KEY",
    "MICROSOFT_FILES_REDIRECT_URI",
    "MICROSOFT_FILES_TENANT_ID",
  ])("keeps interactive practice disabled when %s is configured", (name) => {
    expect(trainingPracticeAccess(env, host, true).enabled).toBe(true);
    expect(trainingPracticeAccess({ ...env, [name]: "fixture-only-provider-setting" }, host, true)).toEqual({
      enabled: false, url: null,
    });
  });
});
