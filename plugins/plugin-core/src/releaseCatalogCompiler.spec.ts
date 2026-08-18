import {
  isReleaseEligibleForCohort,
  MAX_COMPILED_CATALOG_BYTES,
  type Release,
  type ReleaseStrategy,
} from "@hot-updater/core";
import { describe, expect, it } from "vitest";

import {
  compileReleaseCatalog,
  projectCompiledCatalog,
  projectCompiledRollbackCatalog,
  referenceCompatibleReleases,
} from "./releaseCatalogCompiler";

const releaseId = (sequence: number): string =>
  `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;

const bundleId = (sequence: number): string =>
  `00000000-0000-7001-8000-${String(sequence).padStart(12, "0")}`;

const release = (
  sequence: number,
  overrides: Partial<Release> = {},
): Release => ({
  bundleId: bundleId(sequence),
  channelId: "channel-production",
  createdAtMs: sequence,
  enabled: true,
  fingerprintHash: null,
  id: releaseId(sequence),
  kind: "BUNDLE",
  message: null,
  operation: "DEPLOY",
  platform: "ios",
  revision: 1,
  rolloutCohortCount: 1000,
  shouldForceUpdate: false,
  sourceReleaseId: null,
  strategy: "APP_VERSION",
  targetAppVersion: "*",
  targetCohorts: [],
  updatedAtMs: sequence,
  ...overrides,
});

function fingerprintRelease(
  sequence: number,
  overrides: Partial<Release> = {},
): Release {
  return release(sequence, {
    fingerprintHash: "fingerprint-a",
    strategy: "FINGERPRINT",
    targetAppVersion: null,
    ...overrides,
  });
}

function compatibleIds(
  releases: readonly Release[],
  appVersion: string,
): readonly string[] {
  return [...referenceCompatibleReleases(releases, appVersion)]
    .sort((left, right) => right.id.localeCompare(left.id))
    .map(({ id }) => id);
}

describe("compileReleaseCatalog", () => {
  it.each([
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-7000-8000-00000000000A",
    "not-a-uuid",
  ])("rejects non-canonical UUIDv7 Release id %s", async (id) => {
    await expect(
      compileReleaseCatalog({
        releases: [release(1, { id })],
        strategy: "APP_VERSION",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RELEASE" });
  });

  it("compiles app-version ranges into exact projection segments", async () => {
    const releases = [
      release(3, { targetAppVersion: "^2.0.0" }),
      release(2, { targetAppVersion: "^1.2.0 || >=3.0.0" }),
      release(1),
    ];
    const compilation = await compileReleaseCatalog({
      releases,
      strategy: "APP_VERSION",
    });

    for (const appVersion of ["v1.4", "2.5.0+build.7", "3.1.0", "0.2.0"]) {
      expect(
        projectCompiledCatalog(compilation.payload, appVersion).map(
          ({ releaseId }) => releaseId,
        ),
      ).toEqual(compatibleIds(releases, appVersion));
    }
  });

  it("is byte-deterministic across provider iteration and target order", async () => {
    const first = release(1, { targetCohorts: ["qa", "design"] });
    const second = release(2);
    const forward = await compileReleaseCatalog({
      releases: [first, second],
      strategy: "APP_VERSION",
    });
    const reverse = await compileReleaseCatalog({
      releases: [
        second,
        { ...first, targetCohorts: ["design", "qa", "design"] },
      ],
      strategy: "APP_VERSION",
    });

    expect(reverse.canonicalPayload).toBe(forward.canonicalPayload);
    expect(reverse.catalogHash).toBe(forward.catalogHash);
  });

  it("keeps a bounded update frontier and the full Bundle rollback spine", async () => {
    const repeatedBundle = bundleId(99);
    const releases = [
      fingerprintRelease(30, { bundleId: repeatedBundle }),
      fingerprintRelease(29, { bundleId: repeatedBundle }),
      fingerprintRelease(28, { bundleId: null, kind: "EMBEDDED" }),
      ...Array.from({ length: 20 }, (_, index) =>
        fingerprintRelease(27 - index),
      ),
    ];
    const compilation = await compileReleaseCatalog({
      releases,
      strategy: "FINGERPRINT",
    });
    const descriptors = projectCompiledCatalog(compilation.payload);

    expect(descriptors).toHaveLength(11);
    expect(projectCompiledRollbackCatalog(compilation.payload)).toHaveLength(
      22,
    );
    expect(compilation.payload.releaseDescriptors).toHaveLength(22);
    expect(
      descriptors.filter(({ bundleId: id }) => id === repeatedBundle),
    ).toHaveLength(1);
    expect(descriptors.every(({ kind }) => kind === "BUNDLE")).toBe(true);
  });

  it("keeps a rollout-ineligible app-version Release for rollback only", async () => {
    const rollbackOnly = release(1, { rolloutCohortCount: 0 });
    const compilation = await compileReleaseCatalog({
      releases: [rollbackOnly],
      strategy: "APP_VERSION",
    });

    expect(projectCompiledCatalog(compilation.payload, "1.0.0")).toEqual([]);
    expect(
      projectCompiledRollbackCatalog(compilation.payload, "1.0.0").map(
        ({ releaseId }) => releaseId,
      ),
    ).toEqual([rollbackOnly.id]);
  });

  it("matches selector reachability across numeric and custom cohorts", async () => {
    const releases = Array.from({ length: 30 }, (_, index) =>
      fingerprintRelease(index + 1, {
        bundleId: bundleId((index % 17) + 1),
        rolloutCohortCount: (index * 73) % 1001,
        targetCohorts: index % 5 === 0 ? ["qa", String((index % 10) + 1)] : [],
      }),
    );
    const ordered = [...releases].sort((left, right) =>
      right.id.localeCompare(left.id),
    );
    const cohorts: Array<string | undefined> = [
      undefined,
      ...Array.from({ length: 1000 }, (_, index) => String(index + 1)),
      "qa",
      "release-catalog-non-targeted-cohort",
    ];
    const expected = new Set<string>();
    for (const cohort of cohorts) {
      const bundleIds = new Set<string>();
      for (const candidate of ordered) {
        if (
          candidate.kind !== "BUNDLE" ||
          candidate.bundleId === null ||
          !isReleaseEligibleForCohort(
            {
              releaseId: candidate.id,
              rolloutCohortCount: candidate.rolloutCohortCount,
              targetCohorts: candidate.targetCohorts,
            },
            cohort,
          ) ||
          bundleIds.has(candidate.bundleId)
        ) {
          continue;
        }
        bundleIds.add(candidate.bundleId);
        expected.add(candidate.id);
        if (bundleIds.size >= 11) break;
      }
    }

    const compilation = await compileReleaseCatalog({
      releases,
      strategy: "FINGERPRINT",
    });
    expect(
      new Set(
        projectCompiledCatalog(compilation.payload).map(
          ({ releaseId }) => releaseId,
        ),
      ),
    ).toEqual(expected);
  });

  it("rejects a history whose exact rollback spine exceeds the catalog limit", async () => {
    const releases = Array.from({ length: 100_000 }, (_, index) =>
      release(index + 1),
    );
    await expect(
      compileReleaseCatalog({ releases, strategy: "APP_VERSION" }),
    ).rejects.toMatchObject({ code: "CATALOG_OVERSIZE" });
  }, 20_000);

  it("retains every supported fingerprint Release for exact rollback", async () => {
    const releases = Array.from({ length: 100 }, (_, index) =>
      fingerprintRelease(index + 1),
    );
    const compilation = await compileReleaseCatalog({
      releases,
      strategy: "FINGERPRINT",
    });

    expect(compilation.diagnostics).toMatchObject({
      descriptorCount: 100,
      releaseCount: 100,
      segmentCount: 1,
    });
    expect(compilation.byteSize).toBeLessThan(MAX_COMPILED_CATALOG_BYTES);
    expect(projectCompiledCatalog(compilation.payload)).toHaveLength(11);
    expect(projectCompiledRollbackCatalog(compilation.payload)).toHaveLength(
      100,
    );
  });

  it("rejects an adversarial rollout frontier instead of truncating candidates", async () => {
    const releases = Array.from({ length: 20_000 }, (_, index) =>
      fingerprintRelease(index + 1, { rolloutCohortCount: 1 }),
    );

    await expect(
      compileReleaseCatalog({ releases, strategy: "FINGERPRINT" }),
    ).rejects.toMatchObject({
      code: "CATALOG_OVERSIZE",
    });
  }, 20_000);

  it("rejects mixed strategies before producing catalog bytes", async () => {
    const strategy: ReleaseStrategy = "APP_VERSION";
    await expect(
      compileReleaseCatalog({
        releases: [fingerprintRelease(1)],
        strategy,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_RELEASE",
    });
  });
});
