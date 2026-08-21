import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/core";
import { createMockDatabaseData, mockDatabase } from "@hot-updater/mock";
import type { Bundle } from "@hot-updater/plugin-core";
import {
  bundleToPatchRows,
  bundleToRow,
  compileReleaseCatalog,
  createDatabaseClient,
  type DatabasePlugin,
  extractTimestampFromUUIDv7,
  releaseRowToRelease,
  type ReleaseCatalogRow,
  type ReleaseRow,
} from "@hot-updater/plugin-core";
import { vi } from "vitest";

import type { DeploymentWrite } from "./deployTransaction";

export type DeploymentSeed = Omit<DeploymentWrite, "authorityId">;

const createdAtMsFromId = (id: string): number => {
  try {
    const timestamp = extractTimestampFromUUIDv7(id);
    return Number.isSafeInteger(timestamp) ? timestamp : 0;
  } catch {
    return 0;
  }
};

const compileSeedCatalogs = async (
  authorityId: string,
  deployments: readonly DeploymentSeed[],
): Promise<{
  readonly catalogs: readonly {
    readonly channelName: string;
    readonly row: ReleaseCatalogRow;
  }[];
  readonly releases: readonly {
    readonly channelName: string;
    readonly row: ReleaseRow;
  }[];
}> => {
  if (deployments.length === 0) return { catalogs: [], releases: [] };

  const scopes = new Map<
    string,
    {
      readonly channelName: string;
      readonly fingerprintHash: string | null;
      readonly platform: Bundle["platform"];
      readonly releases: ReleaseRow[];
      readonly strategy: "APP_VERSION" | "FINGERPRINT";
    }
  >();

  for (const { bundle, release: policy } of deployments) {
    const strategy =
      policy.fingerprintHash === null ? "APP_VERSION" : "FINGERPRINT";
    const channelKey = encodeChannelKey(policy.channel);
    const scopeKey =
      strategy === "APP_VERSION"
        ? createReleaseCatalogScopeKey({
            authorityId,
            channelKey,
            platform: bundle.platform,
            strategy,
          })
        : createReleaseCatalogScopeKey({
            authorityId,
            channelKey,
            fingerprintHash: policy.fingerprintHash ?? "",
            platform: bundle.platform,
            strategy,
          });
    const createdAtMs = createdAtMsFromId(bundle.id);
    const release: ReleaseRow = {
      id: bundle.id,
      revision: 1,
      scope_key: scopeKey,
      channel_id: policy.channel,
      platform: bundle.platform,
      kind: "BUNDLE",
      bundle_id: bundle.id,
      strategy,
      target_app_version: policy.targetAppVersion,
      fingerprint_hash: policy.fingerprintHash,
      enabled: policy.enabled,
      should_force_update: policy.shouldForceUpdate,
      message: policy.message,
      rollout_cohort_count: policy.rolloutCohortCount ?? 1000,
      target_cohorts: policy.targetCohorts ?? [],
      operation: "DEPLOY",
      source_release_id: null,
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
    };
    const scope = scopes.get(scopeKey);
    if (scope === undefined) {
      scopes.set(scopeKey, {
        channelName: policy.channel,
        fingerprintHash: policy.fingerprintHash,
        platform: bundle.platform,
        releases: [release],
        strategy,
      });
    } else {
      scope.releases.push(release);
    }
  }

  const catalogs: {
    channelName: string;
    row: ReleaseCatalogRow;
  }[] = [];
  const releases: {
    channelName: string;
    row: ReleaseRow;
  }[] = [];
  for (const [scopeKey, scope] of [...scopes].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    scope.releases.sort((left, right) => left.id.localeCompare(right.id));
    releases.push(
      ...scope.releases.map((row) => ({
        channelName: scope.channelName,
        row,
      })),
    );
    const compilation = await compileReleaseCatalog({
      releases: scope.releases.map(releaseRowToRelease),
      strategy: scope.strategy,
    });
    catalogs.push({
      channelName: scope.channelName,
      row: {
        scope_key: scopeKey,
        authority_id: authorityId,
        strategy: scope.strategy,
        channel_id: scope.channelName,
        channel_key: encodeChannelKey(scope.channelName),
        platform: scope.platform,
        fingerprint_hash: scope.fingerprintHash,
        generation: 1,
        payload: compilation.canonicalPayload,
        catalog_hash: compilation.catalogHash,
        byte_size: compilation.byteSize,
        is_tombstone: compilation.payload.releaseDescriptors.length === 0,
        updated_at_ms: Math.max(
          ...scope.releases.map(({ updated_at_ms }) => updated_at_ms),
        ),
      },
    });
  }
  return { catalogs, releases };
};

export const createDatabasePluginHarness = () => {
  const data = createMockDatabaseData();
  const basePlugin = mockDatabase({ data, latency: { min: 0, max: 0 } });
  const read = vi.fn(async (): Promise<void> => {});
  const commit = vi.fn((input) => basePlugin.commit(input));
  const dispose = vi.fn(async (): Promise<void> => {});
  const plugin: DatabasePlugin = {
    name: "test-database-v2",
    models: {
      bundles: {
        async findById(id) {
          await read();
          return basePlugin.models.bundles.findById(id);
        },
        async findMany(query) {
          await read();
          return basePlugin.models.bundles.findMany(query);
        },
        async count(where) {
          await read();
          return basePlugin.models.bundles.count(where);
        },
      },
      bundlePatches: {
        async findByBundleIds(bundleIds) {
          await read();
          return basePlugin.models.bundlePatches.findByBundleIds(bundleIds);
        },
      },
      releases: {
        async findById(id) {
          await read();
          return basePlugin.models.releases.findById(id);
        },
        async findMany(input) {
          await read();
          return basePlugin.models.releases.findMany(input);
        },
        async findManyByScope(input) {
          await read();
          return basePlugin.models.releases.findManyByScope(input);
        },
      },
      releaseCatalogs: {
        async findByScopeKey(scopeKey) {
          await read();
          return basePlugin.models.releaseCatalogs.findByScopeKey(scopeKey);
        },
        async findMany(input) {
          await read();
          return basePlugin.models.releaseCatalogs.findMany(input);
        },
      },
      channels: {
        insert: (input) => basePlugin.models.channels.insert(input),
        async list(input) {
          await read();
          return basePlugin.models.channels.list(input);
        },
        delete: (input) => basePlugin.models.channels.delete(input),
      },
      analytics: basePlugin.models.analytics,
      apiKeys: basePlugin.models.apiKeys,
    },
    commit,
    dispose,
  };

  const setBundles = (bundles: readonly Bundle[]): void => {
    data.bundles.clear();
    data.bundlePatches.clear();
    data.channels.clear();
    data.releaseCatalogs.clear();
    data.releases.clear();
    for (const bundle of bundles) {
      data.bundles.set(bundle.id, bundleToRow(bundle));
      for (const patch of bundleToPatchRows(bundle)) {
        data.bundlePatches.set(patch.id, patch);
      }
    }
    return;
  };

  return {
    plugin,
    commit,
    read,
    dispose,
    bundles: async (): Promise<Bundle[]> =>
      (
        await createDatabaseClient(plugin).getBundles({
          limit: 100,
        })
      ).data,
    releases: () =>
      plugin.models.releases.findMany({
        limit: 100,
      }),
    reset: (): void => {
      data.bundles.clear();
      data.bundlePatches.clear();
      data.bundleEvents.clear();
      data.channels.clear();
      data.apiKeys.clear();
      data.releaseCatalogs.clear();
      data.releases.clear();
      read.mockReset().mockResolvedValue(undefined);
      commit
        .mockReset()
        .mockImplementation((input) => basePlugin.commit(input));
    },
    setBundles,
    seedDeployments: async (
      deployments: readonly DeploymentSeed[],
      authorityId = "default",
    ): Promise<void> => {
      setBundles(deployments.map(({ bundle }) => bundle));
      const channels = [
        ...new Set(deployments.map(({ release }) => release.channel)),
      ].map((name) => ({ id: `channel-${name}`, name }));
      for (const channel of channels) data.channels.set(channel.id, channel);
      const channelIds = new Map(
        [...data.channels.values()].map(({ id, name }) => [name, id]),
      );
      const compiled = await compileSeedCatalogs(authorityId, deployments);
      for (const release of compiled.releases) {
        data.releases.set(release.row.id, {
          ...release.row,
          channel_id: channelIds.get(release.channelName)!,
        });
      }
      for (const catalog of compiled.catalogs) {
        data.releaseCatalogs.set(catalog.row.scope_key, {
          ...catalog.row,
          channel_id: channelIds.get(catalog.channelName)!,
        });
      }
    },
  };
};
