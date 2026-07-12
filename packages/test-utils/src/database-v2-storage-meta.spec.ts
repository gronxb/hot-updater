import { describe, expect, it } from "vitest";

import {
  runDatabaseV2CursorBindingScenario,
  runDatabaseV2HappyReadAndScopeScenario,
} from "./database-v2/readScenarios";
import {
  runDatabaseV2AtomicityScenario,
  runDatabaseV2ReplayScenario,
} from "./database-v2/receiptScenarios";
import { createScriptedDatabaseConnectorV2Harness } from "./database-v2/spec-support/scriptedHarness";

describe("database-v2 storage conformance negative controls", () => {
  it("detects a partial write for a rejected atomic change set", async () => {
    // Given
    const harness = createScriptedDatabaseConnectorV2Harness(["partial-write"]);

    // When / Then
    await expect(runDatabaseV2AtomicityScenario(harness)).rejects.toMatchObject(
      {
        name: "DatabaseConnectorV2ConformanceViolation",
        check: "atomicity",
      },
    );
  });

  it("detects a cursor accepted under another principal or query", async () => {
    // Given
    const harness = createScriptedDatabaseConnectorV2Harness([
      "accept-foreign-cursor",
    ]);

    // When / Then
    await expect(
      runDatabaseV2CursorBindingScenario(harness),
    ).rejects.toMatchObject({
      name: "DatabaseConnectorV2ConformanceViolation",
      check: "cursor-binding",
    });
  });

  it("detects rows leaking across asserted tenants", async () => {
    // Given
    const harness = createScriptedDatabaseConnectorV2Harness([
      "cross-tenant-read",
    ]);

    // When / Then
    await expect(
      runDatabaseV2HappyReadAndScopeScenario(harness),
    ).rejects.toMatchObject({
      name: "DatabaseConnectorV2ConformanceViolation",
      check: "scope-isolation",
    });
  });

  it("detects replay that reapplies a domain mutation", async () => {
    // Given
    const harness = createScriptedDatabaseConnectorV2Harness([
      "reapply-replay",
    ]);

    // When / Then
    await expect(runDatabaseV2ReplayScenario(harness)).rejects.toMatchObject({
      name: "DatabaseConnectorV2ConformanceViolation",
      check: "replay-identity",
    });
  });

  it("detects an empty principal accepted as asserted scope", async () => {
    // Given
    const harness = createScriptedDatabaseConnectorV2Harness([
      "accept-empty-principal",
    ]);

    // When / Then
    await expect(
      runDatabaseV2HappyReadAndScopeScenario(harness),
    ).rejects.toMatchObject({
      name: "DatabaseConnectorV2ConformanceViolation",
      check: "malformed-input",
    });
  });

  it("detects backend I/O attempted before invalid scope rejection", async () => {
    // Given
    const harness = createScriptedDatabaseConnectorV2Harness([
      "invalid-scope-backend-io",
    ]);

    // When / Then
    await expect(
      runDatabaseV2HappyReadAndScopeScenario(harness),
    ).rejects.toMatchObject({
      name: "DatabaseConnectorV2ConformanceViolation",
      check: "scope-zero-io",
    });
  });

  it("detects a payload collision that replaces the original receipt", async () => {
    // Given
    const harness = createScriptedDatabaseConnectorV2Harness([
      "replace-receipt-on-collision",
    ]);

    // When / Then
    await expect(runDatabaseV2ReplayScenario(harness)).rejects.toMatchObject({
      name: "DatabaseConnectorV2ConformanceViolation",
      check: "replay-identity",
    });
  });
});
