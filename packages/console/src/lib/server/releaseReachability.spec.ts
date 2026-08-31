import type { Release } from "@hot-updater/core";
import type { ReleaseCatalogRow, ReleaseRow } from "@hot-updater/plugin-core";
import { compileReleaseCatalog } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  addReleaseReachability,
  collectCurrentlyReachableReleaseIds,
} from "./releaseReachability";

const releaseId = (sequence: number): string =>
  `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;

const bundleId = (sequence: number): string =>
  `00000000-0000-7001-8000-${String(sequence).padStart(12, "0")}`;

const release = (
  sequence: number,
  overrides: Partial<Release> = {},
): Release => ({
  bundleId: bundleId(sequence),
  channelId: "production",
  createdAtMs: sequence,
  enabled: true,
  fingerprintHash: null,
  id: releaseId(sequence),
  kind: "BUNDLE",
  message: null,
  operation: "DEPLOY",
  platform: "ios",
  revision: 1,
  rolloutCohortCount: 1_000,
  shouldForceUpdate: false,
  sourceReleaseId: null,
  strategy: "APP_VERSION",
  targetAppVersion: "1.x",
  targetCohorts: [],
  updatedAtMs: sequence,
  ...overrides,
});

const releaseRow = (
  value: Release,
  scopeKey = "scope-production",
): ReleaseRow => ({
  bundle_id: value.bundleId,
  channel_id: value.channelId,
  created_at_ms: value.createdAtMs,
  enabled: value.enabled,
  fingerprint_hash: value.fingerprintHash,
  id: value.id,
  kind: value.kind,
  message: value.message,
  operation: value.operation,
  platform: value.platform,
  revision: value.revision,
  rollout_cohort_count: value.rolloutCohortCount,
  scope_key: scopeKey,
  should_force_update: value.shouldForceUpdate,
  source_release_id: value.sourceReleaseId,
  strategy: value.strategy,
  target_app_version: value.targetAppVersion,
  target_cohorts: value.targetCohorts,
  updated_at_ms: value.updatedAtMs,
});

const catalogRow = (
  payload: string,
  scopeKey = "scope-production",
): ReleaseCatalogRow => ({
  catalog_id: "catalog-a",
  byte_size: payload.length,
  catalog_hash: "sha256:test",
  channel_id: "production",
  channel_key: "production",
  fingerprint_hash: null,
  generation: 1,
  is_tombstone: false,
  payload,
  platform: "ios",
  scope_key: scopeKey,
  strategy: "APP_VERSION",
  updated_at_ms: 1,
});

describe("Release reachability", () => {
  it("makes the previous Release reachable after the latest one is disabled", async () => {
    const latest = release(2);
    const previous = release(1);
    const before = await compileReleaseCatalog({
      releases: [latest, previous],
      strategy: "APP_VERSION",
    });
    const after = await compileReleaseCatalog({
      releases: [{ ...latest, enabled: false }, previous],
      strategy: "APP_VERSION",
    });

    expect([...collectCurrentlyReachableReleaseIds(before.payload)]).toEqual([
      latest.id,
    ]);
    expect([...collectCurrentlyReachableReleaseIds(after.payload)]).toEqual([
      previous.id,
    ]);
  });

  it("keeps Releases reachable when different cohorts can select them first", async () => {
    const qaOnly = release(2, {
      rolloutCohortCount: 0,
      targetCohorts: ["qa"],
    });
    const general = release(1);
    const compilation = await compileReleaseCatalog({
      releases: [qaOnly, general],
      strategy: "APP_VERSION",
    });

    expect(collectCurrentlyReachableReleaseIds(compilation.payload)).toEqual(
      new Set([qaOnly.id, general.id]),
    );
  });

  it("adds a derived flag while loading each page scope only once", async () => {
    const latest = release(2);
    const previous = release(1);
    const compilation = await compileReleaseCatalog({
      releases: [latest, previous],
      strategy: "APP_VERSION",
    });
    const row = catalogRow(compilation.canonicalPayload);
    const findByScopeKey = vi.fn(async () => row);

    const result = await addReleaseReachability({ findByScopeKey }, [
      releaseRow(latest),
      releaseRow(previous),
    ]);

    expect(
      result.map(({ id, currentlyUnreachable }) => ({
        currentlyUnreachable,
        id,
      })),
    ).toEqual([
      { currentlyUnreachable: false, id: latest.id },
      { currentlyUnreachable: true, id: previous.id },
    ]);
    expect(findByScopeKey).toHaveBeenCalledTimes(1);
    expect(findByScopeKey).toHaveBeenCalledWith("scope-production");
  });
});
