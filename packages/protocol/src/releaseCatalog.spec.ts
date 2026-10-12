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
  catalogId: "project-a",
  catalogHash: "hash-10",
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  generation: 10,
  releases,
  rollbackReleases: releases,
  schemaVersion: 1,
  scopeKey: "v1:app-version:ios:production",
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
        currentBundleId: bundleId(0),
        minimumReleaseId: bundleId(1),
      },
    );

    expect(desired).toEqual({
      bundleId: bundleId(1),
      kind: "BUNDLE",
      release: expect.objectContaining({ releaseId: newestReleaseId }),
      releaseId: newestReleaseId,
      shouldForceUpdate: false,
      status: "UPDATE",
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
        currentBundleId: bundleId(0),
        minimumReleaseId: bundleId(1),
      })?.releaseId,
    ).toBe(releaseId(3));
    expect(
      selectDesiredRelease(catalog(releases), {
        builtInBundleId: bundleId(0),
        cohort: "design",
        crashedBundleIds: [],
        currentBundleId: bundleId(0),
        minimumReleaseId: bundleId(1),
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
        currentBundleId: bundleId(0),
        minimumReleaseId: bundleId(1),
      },
    );

    expect(desired?.releaseId).toBe(releaseId(2));
    expect(desired?.bundleId).toBe(bundleId(2));
  });

  it("synthesizes BUILTIN only from an explicit complete-catalog fallback", () => {
    const desired = selectDesiredRelease(catalog([descriptor(1)]), {
      builtInBundleId: bundleId(0),
      cohort: "1",
      crashedBundleIds: [],
      currentBundleId: bundleId(0),
      minimumReleaseId: bundleId(2),
    });

    expect(desired).toEqual({
      bundleId: bundleId(0),
      kind: "BUILTIN",
      release: null,
      releaseId: null,
      shouldForceUpdate: true,
      status: "ROLLBACK",
    });
  });

  it("rolls an ineligible active Release back without applying rollout to the predecessor", () => {
    const desired = selectDesiredRelease(
      catalog([descriptor(4, { rolloutCohortCount: 0 })], {
        rollbackReleases: [
          descriptor(4, { rolloutCohortCount: 0 }),
          descriptor(3, { rolloutCohortCount: 0 }),
        ],
      }),
      {
        activeReleaseId: releaseId(4),
        builtInBundleId: bundleId(0),
        cohort: "not-targeted",
        crashedBundleIds: [],
        currentBundleId: bundleId(4),
        minimumReleaseId: bundleId(1),
      },
    );

    expect(desired).toMatchObject({
      bundleId: bundleId(3),
      releaseId: releaseId(3),
      shouldForceUpdate: true,
      status: "ROLLBACK",
    });
  });

  it("does not roll an active Release at the native minimum floor to BUILTIN", () => {
    const desired = selectDesiredRelease(
      catalog([], { rollbackReleases: [descriptor(3)] }),
      {
        activeReleaseId: releaseId(4),
        builtInBundleId: bundleId(0),
        cohort: "1",
        crashedBundleIds: [],
        currentBundleId: bundleId(4),
        minimumReleaseId: bundleId(4),
      },
    );

    expect(desired).toBeNull();
  });

  it("prefers a newer eligible Release before considering rollback", () => {
    const desired = selectDesiredRelease(
      catalog([descriptor(5), descriptor(4)], {
        rollbackReleases: [descriptor(5), descriptor(4), descriptor(3)],
      }),
      {
        activeReleaseId: releaseId(4),
        builtInBundleId: bundleId(0),
        cohort: "1",
        crashedBundleIds: [],
        currentBundleId: bundleId(4),
        minimumReleaseId: bundleId(1),
      },
    );

    expect(desired).toMatchObject({
      releaseId: releaseId(5),
      status: "UPDATE",
    });
  });

  it("never installs a Bundle below the native minimum floor", () => {
    const desired = selectDesiredRelease(
      catalog([descriptor(5, { bundleId: bundleId(2) })], {
        rollbackReleases: [descriptor(5, { bundleId: bundleId(2) })],
      }),
      {
        activeReleaseId: releaseId(4),
        builtInBundleId: bundleId(3),
        cohort: "1",
        crashedBundleIds: [],
        currentBundleId: bundleId(4),
        minimumReleaseId: bundleId(3),
      },
    );

    expect(desired).toMatchObject({ kind: "BUILTIN", status: "ROLLBACK" });
  });
});

describe("selectDesiredRelease force update", () => {
  const fromRelease = (sequence: number) => ({
    activeReleaseId: releaseId(sequence),
    builtInBundleId: bundleId(0),
    cohort: "1",
    crashedBundleIds: [] as string[],
    currentBundleId: bundleId(sequence),
    minimumReleaseId: bundleId(0),
  });

  it("keeps a skipped forced Release's requirement on the newer selected Release", () => {
    const desired = selectDesiredRelease(
      catalog([
        descriptor(3),
        descriptor(2, { shouldForceUpdate: true }),
        descriptor(1),
      ]),
      fromRelease(1),
    );

    expect(desired).toMatchObject({
      releaseId: releaseId(3),
      shouldForceUpdate: true,
      status: "UPDATE",
    });
  });

  it("uses the selected Release's own flag when nothing forced was skipped", () => {
    expect(
      selectDesiredRelease(
        catalog([descriptor(3, { shouldForceUpdate: true }), descriptor(2)]),
        fromRelease(1),
      )?.shouldForceUpdate,
    ).toBe(true);
    expect(
      selectDesiredRelease(
        catalog([descriptor(3), descriptor(2)]),
        fromRelease(1),
      )?.shouldForceUpdate,
    ).toBe(false);
  });

  it("does not force a device that already runs the forced Release", () => {
    const desired = selectDesiredRelease(
      catalog([descriptor(3), descriptor(2, { shouldForceUpdate: true })]),
      fromRelease(2),
    );

    expect(desired).toMatchObject({
      releaseId: releaseId(3),
      shouldForceUpdate: false,
    });
  });

  it("forces a built-in device past a forced Release published after its binary", () => {
    const desired = selectDesiredRelease(
      catalog([descriptor(3), descriptor(2, { shouldForceUpdate: true })]),
      {
        builtInBundleId: bundleId(1),
        cohort: "1",
        crashedBundleIds: [],
        currentBundleId: bundleId(1),
        minimumReleaseId: bundleId(1),
      },
    );

    expect(desired).toMatchObject({
      releaseId: releaseId(3),
      shouldForceUpdate: true,
    });
  });

  it("measures an explicit channel switch from the built-in bundle", () => {
    // checkForUpdate selects for a switched channel from the native minimum,
    // so the target channel's forced Releases after the binary still count.
    const desired = selectDesiredRelease(
      catalog([descriptor(4), descriptor(3, { shouldForceUpdate: true })]),
      {
        builtInBundleId: bundleId(1),
        cohort: "1",
        crashedBundleIds: [],
        currentBundleId: bundleId(1),
        minimumReleaseId: bundleId(1),
      },
    );

    expect(desired).toMatchObject({
      releaseId: releaseId(4),
      shouldForceUpdate: true,
    });
  });

  it("ignores a forced Release older than the built-in bundle", () => {
    const desired = selectDesiredRelease(
      catalog([descriptor(3), descriptor(1, { shouldForceUpdate: true })]),
      {
        builtInBundleId: bundleId(2),
        cohort: "1",
        crashedBundleIds: [],
        currentBundleId: bundleId(2),
        minimumReleaseId: bundleId(2),
      },
    );

    expect(desired).toMatchObject({
      releaseId: releaseId(3),
      shouldForceUpdate: false,
    });
  });

  it("ignores a skipped forced Release the device's cohort was not eligible for", () => {
    const desired = selectDesiredRelease(
      catalog([
        descriptor(3),
        descriptor(2, {
          rolloutCohortCount: 0,
          shouldForceUpdate: true,
          targetCohorts: ["qa"],
        }),
      ]),
      fromRelease(1),
    );

    expect(desired).toMatchObject({
      releaseId: releaseId(3),
      shouldForceUpdate: false,
    });
  });

  it("ignores a forced Release newer than the selected one", () => {
    const crashedBundleId = bundleId(9);
    const desired = selectDesiredRelease(
      catalog([
        descriptor(3, { bundleId: crashedBundleId, shouldForceUpdate: true }),
        descriptor(2),
      ]),
      { ...fromRelease(1), crashedBundleIds: [crashedBundleId] },
    );

    expect(desired).toMatchObject({
      releaseId: releaseId(2),
      shouldForceUpdate: false,
    });
  });

  it("finds a forced Release the forward frontier dropped", () => {
    // The compiler keeps only the newest Bundles in `releases`; the complete
    // history stays in `rollbackReleases`.
    const history = Array.from({ length: 14 }, (_, offset) =>
      descriptor(15 - offset, { shouldForceUpdate: 15 - offset === 3 }),
    );
    const desired = selectDesiredRelease(
      catalog(history.slice(0, 11), { rollbackReleases: history }),
      fromRelease(2),
    );

    expect(desired).toMatchObject({
      releaseId: releaseId(15),
      shouldForceUpdate: true,
    });
  });

  it("counts from the running Release while a newer one is staged", () => {
    const releases = [
      descriptor(3),
      descriptor(2, { shouldForceUpdate: true }),
      descriptor(1),
    ];

    expect(
      selectDesiredRelease(catalog(releases), {
        ...fromRelease(3),
        currentBundleId: bundleId(1),
        runningReleaseId: releaseId(1),
      }),
    ).toMatchObject({
      releaseId: releaseId(3),
      shouldForceUpdate: true,
      status: "UPDATE",
    });
    expect(
      selectDesiredRelease(catalog(releases), {
        ...fromRelease(3),
        runningReleaseId: releaseId(3),
      })?.shouldForceUpdate,
    ).toBe(false);
  });

  it("treats a forced Release of the running bundle as satisfied", () => {
    // Release 2 re-releases the running bundle 1 as forced; whether the device
    // adopted it before Release 3 arrived must not change the outcome.
    const releases = [
      descriptor(3),
      descriptor(2, { bundleId: bundleId(1), shouldForceUpdate: true }),
      descriptor(1),
    ];

    expect(
      selectDesiredRelease(catalog(releases), fromRelease(1)),
    ).toMatchObject({ releaseId: releaseId(3), shouldForceUpdate: false });
    expect(
      selectDesiredRelease(catalog(releases), {
        ...fromRelease(2),
        currentBundleId: bundleId(1),
      }),
    ).toMatchObject({ releaseId: releaseId(3), shouldForceUpdate: false });
  });

  it("ignores a newer forced Release whose bundle is below the native floor", () => {
    // Release 2 promotes bundle 1, which the binary's floor (bundle 2)
    // already supersedes, so the device could never select it.
    const desired = selectDesiredRelease(
      catalog([
        descriptor(3),
        descriptor(2, { bundleId: bundleId(1), shouldForceUpdate: true }),
      ]),
      {
        ...fromRelease(1),
        builtInBundleId: bundleId(2),
        currentBundleId: bundleId(2),
        minimumReleaseId: bundleId(2),
      },
    );

    expect(desired).toMatchObject({
      releaseId: releaseId(3),
      shouldForceUpdate: false,
    });
  });

  it("does not force re-adopting the running bundle", () => {
    const desired = selectDesiredRelease(
      catalog([descriptor(2, { shouldForceUpdate: true })]),
      { ...fromRelease(2), activeReleaseId: null },
    );

    expect(desired).toMatchObject({
      releaseId: releaseId(2),
      shouldForceUpdate: false,
      status: "UPDATE",
    });
  });
});

describe("createReleaseSelectionContextHash", () => {
  it("is stable across crash-history ordering and changes with selector inputs", () => {
    const base = {
      cohort: " qa ",
      crashedBundleIds: ["bundle-b", "bundle-a", "bundle-a"],
      minimumReleaseId: bundleId(1),
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
        minimumReleaseId: bundleId(2),
      }),
    ).not.toBe(createReleaseSelectionContextHash(base));
    expect(
      createReleaseSelectionContextHash({
        ...base,
        activeBundleId: bundleId(2),
        activeReleaseId: releaseId(2),
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
  catalogId: "project-a",
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
