import { describe, expect, it } from "vitest";

import { runDatabaseV2LifecycleScenario } from "./database-v2/lifecycleScenario";
import { createScriptedDatabaseConnectorV2Harness } from "./database-v2/spec-support/scriptedHarness";
import {
  runDatabaseV2ConcurrentCommitScenario,
  runDatabaseV2UnknownRecoveryScenario,
} from "./database-v2/stateScenarios";

describe("database-v2 state conformance negative controls", () => {
  it("detects backend I/O from the rejected concurrent commit", async () => {
    // Given
    const harness = createScriptedDatabaseConnectorV2Harness([
      "concurrent-backend-io",
    ]);

    // When / Then
    await expect(
      runDatabaseV2ConcurrentCommitScenario(harness),
    ).rejects.toMatchObject({
      name: "DatabaseConnectorV2ConformanceViolation",
      check: "concurrent-zero-io",
    });
  });

  it("detects reads allowed while a session is poisoned", async () => {
    // Given
    const harness = createScriptedDatabaseConnectorV2Harness([
      "allow-poisoned-read",
    ]);

    // When / Then
    await expect(
      runDatabaseV2UnknownRecoveryScenario(harness),
    ).rejects.toMatchObject({
      name: "DatabaseConnectorV2ConformanceViolation",
      check: "unknown-recovery",
    });
  });

  it("detects session use after close", async () => {
    // Given
    const harness = createScriptedDatabaseConnectorV2Harness([
      "allow-use-after-close",
    ]);

    // When / Then
    await expect(runDatabaseV2LifecycleScenario(harness)).rejects.toMatchObject(
      {
        name: "DatabaseConnectorV2ConformanceViolation",
        check: "lifecycle",
      },
    );
  });

  it("detects connection close that leaves child sessions open", async () => {
    // Given
    const harness = createScriptedDatabaseConnectorV2Harness([
      "leave-child-sessions-open",
    ]);

    // When / Then
    await expect(runDatabaseV2LifecycleScenario(harness)).rejects.toMatchObject(
      {
        name: "DatabaseConnectorV2ConformanceViolation",
        check: "lifecycle",
      },
    );
  });

  it("detects connection close resolving before an active child", async () => {
    // Given
    const harness = createScriptedDatabaseConnectorV2Harness([
      "resolve-connection-close-early",
    ]);

    // When / Then
    await expect(runDatabaseV2LifecycleScenario(harness)).rejects.toMatchObject(
      {
        name: "DatabaseConnectorV2ConformanceViolation",
        check: "lifecycle-close-wait",
      },
    );
  });
});
