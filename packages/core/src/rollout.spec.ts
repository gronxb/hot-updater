import { describe, expect, it } from "vitest";
import { isDeviceEligibleForUpdate } from "./rollout";

describe("isDeviceEligibleForUpdate", () => {
  it("is deterministic for the same userId", () => {
    const userId = "device-123";
    const first = isDeviceEligibleForUpdate(userId, 50, null);
    const second = isDeviceEligibleForUpdate(userId, 50, null);
    expect(first).toBe(second);
  });

  it("treats null/undefined/100% as eligible", () => {
    expect(isDeviceEligibleForUpdate("a", undefined, null)).toBe(true);
    expect(isDeviceEligibleForUpdate("a", null, null)).toBe(true);
    expect(isDeviceEligibleForUpdate("a", 100, null)).toBe(true);
    expect(isDeviceEligibleForUpdate("a", 150, null)).toBe(true);
  });

  it("treats 0% (or less) as ineligible", () => {
    expect(isDeviceEligibleForUpdate("a", 0, null)).toBe(false);
    expect(isDeviceEligibleForUpdate("a", -1, null)).toBe(false);
  });

  it("prioritizes targetDeviceIds over rolloutPercentage", () => {
    expect(isDeviceEligibleForUpdate("device-a", 0, ["device-a"])).toBe(true);
    expect(isDeviceEligibleForUpdate("device-b", 100, ["device-a"])).toBe(
      false,
    );
  });

  it("approximates percentage distribution", () => {
    const total = 1000;
    const eligible = Array.from({ length: total }, (_, i) => `device-${i}`)
      .map((id) => isDeviceEligibleForUpdate(id, 50, null))
      .filter(Boolean).length;

    expect(eligible).toBeGreaterThan(450);
    expect(eligible).toBeLessThan(550);
  });
});
