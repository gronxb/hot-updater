import { describe, expect, it } from "vitest";

import {
  assessCatalogAcceptance,
  authorizeReleaseTransition,
  createReleaseSelectionContextHash,
  selectDesiredRelease,
  type PersistedSelectionReceipt,
  type ReleaseCatalog,
  type ReleaseCatalogDescriptor,
} from "./releaseCatalog";
import { getRolledOutNumericCohorts } from "./rollout";

const releaseId = (sequence: number): string =>
  `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;

const bundleId = (sequence: number): string =>
  `00000000-0000-7001-8000-${String(sequence).padStart(12, "0")}`;

const descriptor = (
  sequence: number,
  overrides: Partial<ReleaseCatalogDescriptor> = {},
): ReleaseCatalogDescriptor => ({
  bundleId: bundleId(sequence),
  kind: "BUNDLE",
  message: null,
  releaseId: releaseId(sequence),
  rolloutCohortCount: 1000,
  shouldForceUpdate: false,
  targetCohorts: [],
  ...overrides,
});

const catalog = (
  releases: readonly ReleaseCatalogDescriptor[],
  overrides: Partial<ReleaseCatalog> = {},
): ReleaseCatalog => ({
  authorityId: "project-a",
  catalogHash: "hash-10",
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  generation: 10,
  releases,
  schemaVersion: 1,
  scopeKey: "v1:app-version:project-a:ios:production",
  ...overrides,
});

describe("selectDesiredRelease", () => {
  it("uses Release identity for rollout while keeping Bundle identity for bytes", () => {
    const newestReleaseId = releaseId(3);
    const includedCohort = String(
      getRolledOutNumericCohorts(newestReleaseId, 100)[0],
    );

    const desired = selectDesiredRelease(
      catalog([
        descriptor(3, {
          bundleId: bundleId(1),
          rolloutCohortCount: 100,
        }),
        descriptor(2),
      ]),
      {
        builtInBundleId: bundleId(0),
        cohort: includedCohort,
        crashedBundleIds: [],
        minimumReleaseId: releaseId(1),
      },
    );

    expect(desired).toEqual({
      bundleId: bundleId(1),
      kind: "BUNDLE",
      release: expect.objectContaining({ releaseId: newestReleaseId }),
      releaseId: newestReleaseId,
    });
  });

  it("selects a named target locally and falls through for another cohort", () => {
    const releases = [
      descriptor(3, { rolloutCohortCount: 0, targetCohorts: ["qa"] }),
      descriptor(2),
    ];

    expect(
      selectDesiredRelease(catalog(releases), {
        builtInBundleId: bundleId(0),
        cohort: "qa",
        crashedBundleIds: [],
        minimumReleaseId: releaseId(1),
      })?.releaseId,
    ).toBe(releaseId(3));
    expect(
      selectDesiredRelease(catalog(releases), {
        builtInBundleId: bundleId(0),
        cohort: "design",
        crashedBundleIds: [],
        minimumReleaseId: releaseId(1),
      })?.releaseId,
    ).toBe(releaseId(2));
  });

  it("skips every Release that points at a crashed Bundle", () => {
    const crashedBundleId = bundleId(9);
    const desired = selectDesiredRelease(
      catalog([
        descriptor(4, { bundleId: crashedBundleId }),
        descriptor(3, { bundleId: crashedBundleId }),
        descriptor(2),
      ]),
      {
        builtInBundleId: bundleId(0),
        cohort: "1",
        crashedBundleIds: [crashedBundleId],
        minimumReleaseId: releaseId(1),
      },
    );

    expect(desired?.releaseId).toBe(releaseId(2));
    expect(desired?.bundleId).toBe(bundleId(2));
  });

  it("can select an explicit EMBEDDED Release after crashed Bundle candidates", () => {
    const desired = selectDesiredRelease(
      catalog([
        descriptor(3, { bundleId: bundleId(9) }),
        descriptor(2, { bundleId: null, kind: "EMBEDDED" }),
      ]),
      {
        builtInBundleId: bundleId(0),
        cohort: "1",
        crashedBundleIds: [bundleId(9)],
        minimumReleaseId: releaseId(1),
      },
    );

    expect(desired).toEqual({
      bundleId: bundleId(0),
      kind: "EMBEDDED",
      release: expect.objectContaining({ releaseId: releaseId(2) }),
      releaseId: releaseId(2),
    });
  });

  it("synthesizes BUILTIN only from an explicit complete-catalog fallback", () => {
    const desired = selectDesiredRelease(catalog([descriptor(1)]), {
      builtInBundleId: bundleId(0),
      cohort: "1",
      crashedBundleIds: [],
      minimumReleaseId: releaseId(2),
    });

    expect(desired).toEqual({
      bundleId: bundleId(0),
      kind: "BUILTIN",
      release: null,
      releaseId: null,
    });
  });
});

describe("createReleaseSelectionContextHash", () => {
  it("is stable across crash-history ordering and changes with selector inputs", () => {
    const base = {
      cohort: " qa ",
      crashedBundleIds: ["bundle-b", "bundle-a", "bundle-a"],
      minimumReleaseId: releaseId(1),
      strategy: "APP_VERSION" as const,
      strategyValue: "1.2.3",
    };

    expect(createReleaseSelectionContextHash(base)).toBe(
      createReleaseSelectionContextHash({
        ...base,
        crashedBundleIds: ["bundle-a", "bundle-b"],
        cohort: "qa",
      }),
    );
    expect(
      createReleaseSelectionContextHash({
        ...base,
        crashedBundleIds: ["bundle-a", "bundle-c"],
      }),
    ).not.toBe(createReleaseSelectionContextHash(base));
    expect(
      createReleaseSelectionContextHash({
        ...base,
        minimumReleaseId: releaseId(2),
      }),
    ).not.toBe(createReleaseSelectionContextHash(base));
  });
});

describe("assessCatalogAcceptance", () => {
  it("rejects an older generation and a same-generation hash mismatch", () => {
    expect(
      assessCatalogAcceptance(
        { catalogHash: "old", generation: 9 },
        { catalogHash: "hash-10", generation: 10 },
      ),
    ).toEqual({ accepted: false, reason: "STALE_GENERATION" });

    expect(
      assessCatalogAcceptance(
        { catalogHash: "different", generation: 10 },
        { catalogHash: "hash-10", generation: 10 },
      ),
    ).toEqual({ accepted: false, reason: "GENERATION_HASH_MISMATCH" });
  });

  it("accepts the same immutable generation and advances a newer generation", () => {
    expect(
      assessCatalogAcceptance(
        { catalogHash: "hash-10", generation: 10 },
        { catalogHash: "hash-10", generation: 10 },
      ),
    ).toEqual({ accepted: true, shouldAdvanceHighWater: false });

    expect(
      assessCatalogAcceptance(
        { catalogHash: "hash-11", generation: 11 },
        { catalogHash: "hash-10", generation: 10 },
      ),
    ).toEqual({ accepted: true, shouldAdvanceHighWater: true });
  });
});

const receipt = (
  releaseSequence: number,
  overrides: Partial<PersistedSelectionReceipt> = {},
): PersistedSelectionReceipt => ({
  authorityId: "project-a",
  bundleId: bundleId(releaseSequence),
  catalogHash: "hash-10",
  channel: "production",
  generation: 10,
  kind: "BUNDLE",
  releaseId: releaseId(releaseSequence),
  scopeKey: "scope-production",
  selectionContextHash: "cohort=1;crash=none",
  ...overrides,
});

describe("authorizeReleaseTransition", () => {
  it("authorizes a lower Release for a newer canonical generation", () => {
    expect(
      authorizeReleaseTransition({
        active: receipt(3),
        desired: receipt(2, {
          catalogHash: "hash-11",
          generation: 11,
        }),
        explicitScopeSwitch: false,
      }),
    ).toEqual({ authorized: true, reason: "NEWER_POLICY" });
  });

  it("authorizes same-generation switchback only when selection context changed", () => {
    expect(
      authorizeReleaseTransition({
        active: receipt(3),
        desired: receipt(2, {
          selectionContextHash: "cohort=qa;crash=none",
        }),
        explicitScopeSwitch: false,
      }),
    ).toEqual({ authorized: true, reason: "CONTEXT_RESELECTION" });

    expect(
      authorizeReleaseTransition({
        active: receipt(3),
        desired: receipt(2),
        explicitScopeSwitch: false,
      }),
    ).toEqual({ authorized: false, reason: "BACKWARD_NOT_AUTHORIZED" });
  });

  it("treats crash-history change as a same-generation reselection context", () => {
    expect(
      authorizeReleaseTransition({
        active: receipt(3),
        desired: receipt(2, {
          selectionContextHash: "cohort=1;crash=bundle-3",
        }),
        explicitScopeSwitch: false,
      }),
    ).toEqual({ authorized: true, reason: "CONTEXT_RESELECTION" });
  });

  it("never lets an old generation or unsolicited scope overwrite active state", () => {
    expect(
      authorizeReleaseTransition({
        active: receipt(3),
        desired: receipt(4, { generation: 9 }),
        explicitScopeSwitch: false,
      }),
    ).toEqual({ authorized: false, reason: "STALE_GENERATION" });

    expect(
      authorizeReleaseTransition({
        active: receipt(3),
        desired: receipt(4, { scopeKey: "scope-beta" }),
        explicitScopeSwitch: false,
      }),
    ).toEqual({ authorized: false, reason: "UNSOLICITED_SCOPE" });
  });

  it("allows an explicit target scope only when it selected a real Release", () => {
    expect(
      authorizeReleaseTransition({
        active: receipt(3),
        desired: receipt(4, { channel: "beta", scopeKey: "scope-beta" }),
        explicitScopeSwitch: true,
      }),
    ).toEqual({ authorized: true, reason: "EXPLICIT_SCOPE_SWITCH" });

    expect(
      authorizeReleaseTransition({
        active: receipt(3),
        desired: receipt(0, {
          channel: "beta",
          kind: "BUILTIN",
          releaseId: null,
          scopeKey: "scope-beta",
        }),
        explicitScopeSwitch: true,
      }),
    ).toEqual({ authorized: false, reason: "EMPTY_TARGET_SCOPE" });
  });
});
