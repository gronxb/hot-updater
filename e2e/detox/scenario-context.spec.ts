import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  addFailureArtifact,
  addStageTiming,
  createScenarioContext,
  resolveDetoxArtifactsDir,
} from "./scenario-context.ts";

describe("Detox scenario context", () => {
  it("keeps typed scenario ids and failure artifacts together", () => {
    // Given: a dashboard job needs Detox artifacts in a provider-specific dir.
    const artifactsDir = resolveDetoxArtifactsDir({
      artifactsRoot: path.join("artifacts", "job-123"),
      jobId: "job-123",
    });
    const context = createScenarioContext({
      artifactsDir,
      channel: "e2e-job-123",
      platform: "ios",
      scenarioName: "release-ota-recovery",
      targetAppVersion: "1.0",
    });

    // When: a failure artifact is recorded.
    const nextContext = addFailureArtifact(context, {
      kind: "view-hierarchy",
      label: "metadata assertion",
      path: path.join("tmp", "metadata-view.json"),
    });

    // Then: scenario evidence stays explicit and Detox-scoped.
    expect(artifactsDir).toBe(path.join("artifacts", "job-123", "detox"));
    expect(context.failureArtifacts).toEqual([]);
    expect(nextContext.failureArtifacts).toEqual([
      {
        kind: "view-hierarchy",
        label: "metadata assertion",
        path: path.join("artifacts", "job-123", "detox", "metadata-view.json"),
      },
    ]);
  });

  it("adds stage timings without mutating the original context", () => {
    // Given: a scenario context has no stage timings yet.
    const context = createScenarioContext({
      artifactsDir: path.join("artifacts", "job-timing", "detox"),
      channel: "e2e-job-timing",
      platform: "ios",
      scenarioName: "release-ota-recovery",
      targetAppVersion: "1.0",
    });

    // When: a stage timing is recorded.
    const nextContext = addStageTiming(context, {
      durationMs: 25,
      endedAtMs: 125,
      outcome: "succeeded",
      stage: "bundle deploy",
      startedAtMs: 100,
    });

    // Then: timing evidence is appended to a new context object.
    expect(context.stageTimings).toEqual([]);
    expect(nextContext.stageTimings).toEqual([
      {
        durationMs: 25,
        endedAtMs: 125,
        outcome: "succeeded",
        stage: "bundle deploy",
        startedAtMs: 100,
      },
    ]);
  });
});
