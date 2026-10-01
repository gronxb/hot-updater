import { describe, expect, it } from "vitest";

import {
  getRolledOutNumericCohorts,
  INVALID_COHORT_ERROR_MESSAGE,
  isCohortEligibleForUpdate,
  isCustomCohort,
  isValidCohort,
  MAX_COHORT_LENGTH,
  NUMERIC_COHORT_SIZE,
} from "./rollout";

describe("getRolledOutNumericCohorts", () => {
  it("returns an ascending numeric cohort set that matches rollout eligibility", () => {
    const rolloutCohorts = getRolledOutNumericCohorts("bundle-a", 137);

    expect(rolloutCohorts).toHaveLength(137);
    expect(rolloutCohorts).toEqual([...rolloutCohorts].sort((a, b) => a - b));
    expect(new Set(rolloutCohorts).size).toBe(137);

    for (const cohortValue of rolloutCohorts) {
      expect(
        isCohortEligibleForUpdate("bundle-a", String(cohortValue), 137, null),
      ).toBe(true);
    }

    const excludedCohort = Array.from(
      { length: NUMERIC_COHORT_SIZE },
      (_, index) => index + 1,
    ).find((cohortValue) => !rolloutCohorts.includes(cohortValue));

    expect(excludedCohort).toBeDefined();
    expect(
      isCohortEligibleForUpdate("bundle-a", String(excludedCohort), 137, null),
    ).toBe(false);
  });

  it("keeps the existing cohort set when rollout expands", () => {
    const smallRollout = new Set(getRolledOutNumericCohorts("bundle-b", 100));
    const largeRollout = new Set(getRolledOutNumericCohorts("bundle-b", 400));

    expect(largeRollout.size).toBe(400);

    for (const cohortValue of smallRollout) {
      expect(largeRollout.has(cohortValue)).toBe(true);
    }
  });

  it("returns empty and full sets at the rollout boundaries", () => {
    expect(getRolledOutNumericCohorts("bundle-c", 0)).toEqual([]);
    expect(getRolledOutNumericCohorts("bundle-c", NUMERIC_COHORT_SIZE)).toEqual(
      Array.from({ length: NUMERIC_COHORT_SIZE }, (_, index) => index + 1),
    );
  });
});

describe("isCohortEligibleForUpdate", () => {
  it("keeps numeric rollout active when target cohorts are configured", () => {
    const bundleId = "bundle-d";
    const rolloutCohorts = getRolledOutNumericCohorts(bundleId, 137);

    expect(
      isCohortEligibleForUpdate(bundleId, String(rolloutCohorts[0]), 137, [
        "qa-group",
      ]),
    ).toBe(true);
  });

  it("includes targeted custom cohorts in addition to numeric rollout", () => {
    expect(
      isCohortEligibleForUpdate("bundle-e", "qa-group", 137, ["qa-group"]),
    ).toBe(true);
  });

  it("includes targeted numeric cohorts even when rollout excludes them", () => {
    const bundleId = "bundle-f";
    const rolloutCohorts = new Set(getRolledOutNumericCohorts(bundleId, 10));
    const excludedCohort = Array.from(
      { length: NUMERIC_COHORT_SIZE },
      (_, index) => index + 1,
    ).find((cohortValue) => !rolloutCohorts.has(cohortValue));

    if (excludedCohort === undefined) {
      throw new Error("Expected an excluded cohort for partial rollout");
    }

    expect(
      isCohortEligibleForUpdate(bundleId, String(excludedCohort), 10, [
        String(excludedCohort),
      ]),
    ).toBe(true);
  });
});

describe("cohort validation", () => {
  it("rejects empty cohorts and numeric strings outside 1..1000", () => {
    expect(isValidCohort("")).toBe(false);
    expect(isValidCohort("1001")).toBe(false);
    expect(isCustomCohort("1001")).toBe(false);
  });

  it("rejects custom cohorts longer than the limit", () => {
    expect(isValidCohort("a".repeat(MAX_COHORT_LENGTH))).toBe(true);
    expect(isValidCohort("a".repeat(MAX_COHORT_LENGTH + 1))).toBe(false);
  });

  it("exports the shared cohort validation message", () => {
    expect(INVALID_COHORT_ERROR_MESSAGE).toContain(String(MAX_COHORT_LENGTH));
  });
});
