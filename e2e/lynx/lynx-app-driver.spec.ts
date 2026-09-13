import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createControlClient } from "../detox/control-client.ts";
import { LynxAppDriver } from "./lynx-app-driver.ts";

function createDriver(readScreenState: () => Record<string, unknown>) {
  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ screenState: readScreenState() }),
  }));
  const client = createControlClient({
    baseUrl: "http://control.test",
    fetch,
  });
  return { driver: new LynxAppDriver(client, "ios", {}), fetch };
}

describe("Lynx app text assertions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([false, true])(
    "rejects unsupported IDs instead of passing silently (exact=%s)",
    async (exactText) => {
      const { driver, fetch } = createDriver(() => ({
        updateActionResult: "expected text",
      }));
      await expect(
        driver.assertText("unknown field", "unknown-test-id", "expected text", {
          exactText,
        }),
      ).rejects.toThrow("Unsupported Lynx text assertion: unknown-test-id");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not infer an empty crash history from unrelated UUIDs", async () => {
    const { driver } = createDriver(() => {
      vi.setSystemTime(60_000);
      return {
        currentBundleId: "00000000-0000-7000-8000-000000000000",
        updateActionResult: "current-channel -> installed ID release-0",
      };
    });
    await expect(
      driver.assertText("empty crash history", "crash-history-count", "0"),
    ).rejects.toThrow("crash-history-count (crashHistoryCount)");
  });

  it("requires the real crash count for an exact assertion", async () => {
    const { driver } = createDriver(() => {
      vi.setSystemTime(60_000);
      return {
        crashHistoryCount: "0",
        updateActionResult: "recorded 10 crashes",
      };
    });
    await expect(
      driver.assertText("loaded crash history", "crash-history-count", "10", {
        exactText: true,
      }),
    ).rejects.toThrow('received "0"');
  });

  it.each([
    ["runtime-bundle-id", "currentBundleId", "stagingBundleId", "bundle-B"],
    [
      "runtime-release-state",
      "currentReleaseId",
      "stagingReleaseId",
      "release-B",
    ],
    ["runtime-current-cohort", "currentCohort", "cohortInput", "qa"],
  ])(
    "does not satisfy %s from staged state or an action result",
    async (testID, field, unrelatedField, expected) => {
      const { driver } = createDriver(() => {
        vi.setSystemTime(60_000);
        return {
          [field]: null,
          [unrelatedField]: expected,
          updateActionResult: `installed ${expected}`,
        };
      });
      await expect(
        driver.assertText("current runtime", testID, expected),
      ).rejects.toThrow(`${testID} (${field})`);
    },
  );

  it.each([
    ["runtime-bundle-id", "currentBundleId", "bundle-A"],
    ["runtime-release-state", "currentReleaseId", "release-A"],
    ["runtime-current-cohort", "currentCohort", "qa"],
    ["crash-history-count", "crashHistoryCount", "10"],
  ])(
    "accepts the actual published %s value",
    async (testID, field, expected) => {
      const { driver } = createDriver(() => ({ [field]: expected }));
      await expect(
        driver.assertText("current runtime", testID, expected, {
          exactText: true,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("waits for the field itself and honors exact text", async () => {
    let currentReleaseId: string | null = null;
    const { driver, fetch } = createDriver(() => ({
      currentReleaseId,
      updateActionResult: "installed release-A",
    }));
    let complete = false;
    const assertion = driver
      .assertText("running release", "runtime-release-state", "release-A", {
        exactText: true,
      })
      .then(() => {
        complete = true;
      });
    await vi.advanceTimersByTimeAsync(250);
    expect(complete).toBe(false);
    currentReleaseId = "release-A-extra";
    await vi.advanceTimersByTimeAsync(250);
    expect(complete).toBe(false);
    currentReleaseId = "release-A";
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(complete).toBe(true);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  });
});
