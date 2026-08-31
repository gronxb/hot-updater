import { describe, expect, it } from "vitest";

import { createMemoryDatabasePlugin } from "./databasePluginMemory.testFixtures";
import type { ReleaseCatalogRow, ReleaseRow } from "./types";

const scopeKey = "v1:app-version:ios:cHJvZHVjdGlvbg";

const releaseRow = (revision: number): ReleaseRow => ({
  bundle_id: null,
  channel_id: "channel-production",
  created_at_ms: 1,
  enabled: true,
  fingerprint_hash: null,
  id: "00000000-0000-7000-8000-000000000001",
  kind: "EMBEDDED",
  message: null,
  operation: "DEPLOY",
  platform: "ios",
  revision,
  rollout_cohort_count: 1000,
  scope_key: scopeKey,
  should_force_update: false,
  source_release_id: null,
  strategy: "APP_VERSION",
  target_app_version: ">=1.0.0",
  target_cohorts: [],
  updated_at_ms: revision,
});

const catalogRow = (generation: number): ReleaseCatalogRow => ({
  catalog_id: "project-a",
  byte_size: 2,
  catalog_hash: `sha256:generation-${generation}`,
  channel_id: "channel-production",
  channel_key: "cHJvZHVjdGlvbg",
  fingerprint_hash: null,
  generation,
  is_tombstone: false,
  payload: "{}",
  platform: "ios",
  scope_key: scopeKey,
  strategy: "APP_VERSION",
  updated_at_ms: generation,
});

describe("Release/catalog atomic commit", () => {
  it("commits canonical policy and its projection under revision/generation CAS", async () => {
    const plugin = createMemoryDatabasePlugin();
    await plugin.models.channels.insert({
      onConflict: "returnExisting",
      row: { id: "channel-production", name: "production" },
    });

    expect(
      await plugin.commit({
        changes: [
          { model: "releases", operation: "insert", row: releaseRow(1) },
          {
            model: "releaseCatalogs",
            operation: "put",
            row: catalogRow(1),
          },
        ],
        expectations: [
          { id: releaseRow(1).id, model: "releases", revision: null },
          { generation: null, model: "releaseCatalogs", scopeKey },
        ],
      }),
    ).toEqual({ committed: true });

    expect(
      await plugin.commit({
        changes: [
          {
            model: "releases",
            operation: "update",
            update: { revision: 2, updated_at_ms: 2 },
            where: { id: releaseRow(1).id },
          },
          {
            model: "releaseCatalogs",
            operation: "put",
            row: catalogRow(2),
          },
        ],
        expectations: [
          { id: releaseRow(1).id, model: "releases", revision: 1 },
          { generation: 1, model: "releaseCatalogs", scopeKey },
        ],
      }),
    ).toEqual({ committed: true });

    const stale = await plugin.commit({
      changes: [
        {
          model: "releases",
          operation: "update",
          update: { revision: 3, updated_at_ms: 3 },
          where: { id: releaseRow(1).id },
        },
        {
          model: "releaseCatalogs",
          operation: "put",
          row: catalogRow(3),
        },
      ],
      expectations: [
        { id: releaseRow(1).id, model: "releases", revision: 1 },
        { generation: 1, model: "releaseCatalogs", scopeKey },
      ],
    });

    expect(stale).toMatchObject({
      committed: false,
      conflict: {
        actualVersion: 2,
        expectedVersion: 1,
        reason: "version_conflict",
      },
    });
    expect(
      await plugin.models.releases.findById(releaseRow(1).id),
    ).toMatchObject({ revision: 2 });
    expect(
      await plugin.models.releaseCatalogs.findByScopeKey(scopeKey),
    ).toMatchObject({ generation: 2 });
  });
});
