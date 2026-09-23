import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/core";
import type {
  Bundle,
  BundleDeployment,
  Deployment,
} from "@hot-updater/plugin-core";
import {
  bundleToPatchRows,
  bundleToRow,
  compileReleaseCatalog,
  type DatabasePlugin,
  extractTimestampFromUUIDv7,
  releaseRowToRelease,
  rowToBundle,
  type ReleaseCatalogRow,
  type ReleaseRow,
} from "@hot-updater/plugin-core";
import {
  createMemoryAdapter,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core/internal";
import { createLegacyDatabasePlugin } from "@hot-updater/server/database";
import { createDatabaseCoreApi } from "@hot-updater/server/db";
import { vi } from "vitest";

export type DeploymentSeed = BundleDeployment;

const createdAtMsFromId = (id: string): number => {
  try {
    const timestamp = extractTimestampFromUUIDv7(id);
    return Number.isSafeInteger(timestamp) ? timestamp : 0;
  } catch {
    return 0;
  }
};

const compileSeedCatalogs = async (
  catalogId: string,
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
            channelKey,
            platform: bundle.platform,
            strategy,
          })
        : createReleaseCatalogScopeKey({
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
        catalog_id: catalogId,
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

/**
 * A database on the storage engine over a memory adapter, as a provider
 * gives the CLI: its legacy models and commit for seeding, and the adapter
 * the CLI opens core on. Every read passes `read` first.
 */
export const createDatabasePluginHarness = () => {
  const read = vi.fn(async (): Promise<void> => {});
  const dispose = vi.fn(async (): Promise<void> => {});
  let memory = createMemoryAdapter();
  const adapter: DatabaseAdapter = {
    id: "memory",
    fits: (ops) => memory.fits(ops),
    get: async (table, keys) => {
      await read();
      return memory.get(table, keys);
    },
    query: async (table, request) => {
      await read();
      return memory.query(table, request);
    },
    write: (ops) => memory.write(ops),
  };
  const facade = createLegacyDatabasePlugin({
    name: "test-database-v2",
    adapter,
  });
  const commit = vi.fn((input: Parameters<typeof facade.commit>[0]) =>
    facade.commit(input),
  );
  const engineCore = createDatabaseCoreApi({ engineAdapter: adapter });
  const deploy = vi.fn((deployments: readonly Deployment[]) =>
    engineCore.deploy(deployments),
  );
  // The CLI opens core through `plugin.core`, so a test can spy on its calls.
  const core = { ...engineCore, deploy };
  const plugin: DatabasePlugin & {
    readonly engineAdapter: DatabaseAdapter;
    readonly core: typeof core;
  } = { ...facade, engineAdapter: adapter, core, commit, dispose };

  const setBundles = async (bundles: readonly Bundle[]): Promise<void> => {
    memory = createMemoryAdapter();
    if (bundles.length === 0) return;
    await facade.commit({
      changes: bundles.flatMap((bundle) => [
        {
          model: "bundles" as const,
          operation: "insert" as const,
          row: bundleToRow(bundle),
        },
        ...bundleToPatchRows(bundle).map((row) => ({
          model: "bundlePatches" as const,
          operation: "insert" as const,
          row,
        })),
      ]),
    });
  };

  return {
    plugin,
    core,
    commit,
    deploy,
    read,
    dispose,
    bundles: async (): Promise<Bundle[]> =>
      (await core.listBundles({ limit: 100, order: "desc" })).map(
        ({ bundle, patches }) => rowToBundle(bundle, patches),
      ),
    releases: () =>
      core.listReleases({ limit: 100, order: "desc", filter: { kind: "all" } }),
    reset: (): void => {
      memory = createMemoryAdapter();
      read.mockReset().mockResolvedValue(undefined);
      commit.mockReset().mockImplementation((input) => facade.commit(input));
      deploy
        .mockReset()
        .mockImplementation((deployments) => engineCore.deploy(deployments));
      dispose.mockClear();
    },
    setBundles,
    seedDeployments: async (
      deployments: readonly DeploymentSeed[],
      catalogId = "default",
    ): Promise<void> => {
      await setBundles(deployments.map(({ bundle }) => bundle));
      const channels = [
        ...new Set(deployments.map(({ release }) => release.channel)),
      ].map((name) => ({ id: `channel-${name}`, name }));
      for (const row of channels) {
        await facade.models.channels.insert({
          row,
          onConflict: "returnExisting",
        });
      }
      const channelIds = new Map(channels.map(({ id, name }) => [name, id]));
      const compiled = await compileSeedCatalogs(catalogId, deployments);
      await facade.commit({
        changes: [
          ...compiled.releases.map((release) => ({
            model: "releases" as const,
            operation: "insert" as const,
            row: {
              ...release.row,
              channel_id: channelIds.get(release.channelName)!,
            },
          })),
          ...compiled.catalogs.map((catalog) => ({
            model: "releaseCatalogs" as const,
            operation: "put" as const,
            row: {
              ...catalog.row,
              channel_id: channelIds.get(catalog.channelName)!,
            },
          })),
        ],
      });
    },
  };
};
