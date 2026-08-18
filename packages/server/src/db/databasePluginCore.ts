import type {
  AppUpdateAvailableInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  LegacyBundle,
} from "@hot-updater/core";
import {
  createReleaseCatalogScopeKey,
  decodeChannelKey,
  encodeChannelKey,
} from "@hot-updater/core";
import {
  type ChannelRow,
  bundleToPatchRows,
  bundleToRow,
  commitReleaseCatalogMutation,
  commitReleaseCatalogMutations,
  createDatabaseClient,
  createUUIDv7After,
  deleteRelease as deleteReleasePolicy,
  preflightReleasePolicy as preflightReleasePolicyMutation,
  rebuildReleaseCatalog as rebuildReleaseCatalogProjection,
  updateReleasePolicy as updateReleasePolicyMutation,
  type DatabaseChange,
  type ReleaseCatalogMutationInput,
  type ReleaseCatalogScope,
  type ReleaseRow,
  isUUIDv7,
} from "@hot-updater/plugin-core";

import {
  createArtifactResolver,
  createLegacyCatalogResolver,
  createReleaseCatalogReader,
} from "./releaseCatalog";
import { assertBundlePersistenceConstraints } from "./schemaEnhancements";
import type { DatabaseAPI, DatabasePlugin } from "./types";

const RELEASE_PAGE_SIZE = 1_000;

const resolveLegacyReleaseScope = async (
  database: DatabasePlugin,
  authorityId: string,
  bundle: LegacyBundle,
  knownChannels?: readonly ChannelRow[],
): Promise<{
  readonly scope: ReleaseCatalogScope;
}> => {
  const existingChannel = (
    knownChannels ?? (await database.models.channels.list({})).channels
  ).find(({ name }) => name === bundle.channel);
  const channel =
    existingChannel ??
    (
      await database.models.channels.insert({
        row: {
          id: `channel:${encodeChannelKey(bundle.channel)}`,
          name: bundle.channel,
        },
        onConflict: "returnExisting",
      })
    ).row;
  const channelKey = encodeChannelKey(channel.name);
  const fingerprintHash = bundle.fingerprintHash ?? null;
  const strategy = fingerprintHash === null ? "APP_VERSION" : "FINGERPRINT";
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
          fingerprintHash: fingerprintHash ?? "",
          platform: bundle.platform,
          strategy,
        });
  return {
    scope: {
      authorityId,
      channelId: channel.id,
      channelName: channel.name,
      fingerprintHash,
      platform: bundle.platform,
      scopeKey,
      strategy,
    },
  };
};

const readLegacyScopeReleases = async (
  database: DatabasePlugin,
  scopeKey: string,
): Promise<readonly ReleaseRow[]> => {
  const rows: ReleaseRow[] = [];
  let afterReleaseId: string | undefined;
  for (;;) {
    const page = await database.models.releases.findManyByScope({
      ...(afterReleaseId === undefined ? {} : { afterReleaseId }),
      consistency: "strong",
      limit: RELEASE_PAGE_SIZE,
      scopeKey,
    });
    rows.push(...page);
    if (page.length < RELEASE_PAGE_SIZE) return rows;
    afterReleaseId = page.at(-1)!.id;
  }
};

const createLegacyRelease = (
  bundle: LegacyBundle,
  scope: ReleaseCatalogScope,
  rows: readonly ReleaseRow[],
): ReleaseRow => {
  const latestReleaseId = rows.at(-1)?.id;
  const now = Date.now();
  const canReuseBundleId =
    isUUIDv7(bundle.id) &&
    (latestReleaseId === undefined || bundle.id > latestReleaseId);
  return {
    bundle_id: bundle.id,
    channel_id: scope.channelId,
    created_at_ms: now,
    enabled: bundle.enabled,
    fingerprint_hash: bundle.fingerprintHash,
    id: canReuseBundleId
      ? bundle.id
      : createUUIDv7After(latestReleaseId ?? null, now),
    kind: "BUNDLE",
    message: bundle.message,
    operation: "DEPLOY",
    platform: bundle.platform,
    revision: 1,
    rollout_cohort_count: bundle.rolloutCohortCount ?? 1_000,
    scope_key: scope.scopeKey,
    should_force_update: bundle.shouldForceUpdate,
    source_release_id: null,
    strategy: scope.strategy,
    target_app_version: bundle.targetAppVersion,
    target_cohorts: bundle.targetCohorts ?? [],
    updated_at_ms: now,
  };
};

const bundleInsertChanges = (
  bundle: LegacyBundle,
  channelId: string,
): readonly DatabaseChange[] => [
  {
    model: "bundles",
    operation: "insert",
    row: bundleToRow(bundle, channelId),
  },
  ...bundleToPatchRows(bundle).map((row) => ({
    model: "bundlePatches" as const,
    operation: "insert" as const,
    row,
  })),
];

const bundleUpdateChanges = (
  bundle: LegacyBundle,
  channelId: string,
  patchesChanged: boolean,
): readonly DatabaseChange[] => {
  const { id: _id, ...row } = bundleToRow(bundle, channelId);
  return [
    {
      model: "bundles",
      operation: "update",
      update: row,
      where: { id: bundle.id },
    },
    ...(patchesChanged
      ? [
          {
            model: "bundlePatches" as const,
            operation: "delete" as const,
            where: { bundleId: bundle.id },
          },
          ...bundleToPatchRows(bundle).map((patchRow) => ({
            model: "bundlePatches" as const,
            operation: "insert" as const,
            row: patchRow,
          })),
        ]
      : []),
  ];
};

export function createDatabasePluginCore(
  database: DatabasePlugin,
  resolveFileUrl: (storageUri: string | null) => Promise<string | null>,
  options?: {
    authorityId?: string;
    beforeOperation?: () => Promise<void>;
    readStorageText?: (storageUri: string) => Promise<string | null>;
  },
): {
  api: DatabaseAPI;
  adapterName: string;
  createMigrator: () => never;
  generateSchema: () => never;
} {
  const client = createDatabaseClient(database);
  const beforeOperation = options?.beforeOperation;
  const authorityId = options?.authorityId ?? "default";
  const getReleaseCatalog = createReleaseCatalogReader(database, authorityId);
  const getArtifact = createArtifactResolver({
    database,
    readStorageText: options?.readStorageText,
    resolveFileUrl,
  });
  const getLegacyUpdate = createLegacyCatalogResolver({
    authorityId,
    getArtifact,
    getCatalog: getReleaseCatalog,
  });
  const getLegacyDatabaseUpdate = createLegacyCatalogResolver({
    authorityId,
    getArtifact: createArtifactResolver({
      database,
      resolveFileUrl: async (storageUri) => storageUri,
    }),
    getCatalog: getReleaseCatalog,
  });
  const api: DatabaseAPI = {
    async getBundleById(id: string): Promise<Bundle | null> {
      await beforeOperation?.();
      return client.getBundleById(id);
    },

    async getUpdateInfo(
      args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
    ): Promise<import("@hot-updater/core").UpdateInfo | null> {
      await beforeOperation?.();
      const info = await getLegacyDatabaseUpdate(args);
      if (info === null) return null;
      const { fileUrl, ...result } = info;
      return { ...result, storageUri: fileUrl };
    },

    async getAppUpdateInfo(
      args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
    ): Promise<AppUpdateAvailableInfo | null> {
      await beforeOperation?.();
      return getLegacyUpdate(args);
    },

    async getReleaseCatalog(input) {
      await beforeOperation?.();
      return getReleaseCatalog(input);
    },

    async getArtifactInfo(targetBundleId, currentBundleId) {
      await beforeOperation?.();
      return getArtifact(targetBundleId, currentBundleId);
    },

    async getReleaseById(id) {
      await beforeOperation?.();
      return database.models.releases.findById(id);
    },

    async getReleasesByScope(input) {
      await beforeOperation?.();
      return database.models.releases.findManyByScope({
        ...input,
        consistency: "strong",
      });
    },

    async getReleases(input) {
      await beforeOperation?.();
      return database.models.releases.findMany(input);
    },

    async getReleaseCatalogByScopeKey(scopeKey) {
      await beforeOperation?.();
      return database.models.releaseCatalogs.findByScopeKey(scopeKey);
    },

    async getReleaseCatalogs(input) {
      await beforeOperation?.();
      return database.models.releaseCatalogs.findMany(input);
    },

    async updateReleasePolicy(input) {
      await beforeOperation?.();
      return updateReleasePolicyMutation({ database, ...input });
    },

    async preflightReleasePolicy(input) {
      await beforeOperation?.();
      return preflightReleasePolicyMutation({ database, ...input });
    },

    async deleteRelease(input) {
      await beforeOperation?.();
      return deleteReleasePolicy({ database, ...input });
    },

    async rebuildReleaseCatalog(scopeKey) {
      await beforeOperation?.();
      const catalog =
        await database.models.releaseCatalogs.findByScopeKey(scopeKey);
      if (catalog === null) {
        throw new Error(`Release catalog "${scopeKey}" was not found.`);
      }
      return rebuildReleaseCatalogProjection({
        database,
        scope: {
          authorityId: catalog.authority_id,
          channelId: catalog.channel_id,
          channelName: decodeChannelKey(catalog.channel_key),
          fingerprintHash: catalog.fingerprint_hash,
          platform: catalog.platform,
          scopeKey: catalog.scope_key,
          strategy: catalog.strategy,
        },
      });
    },

    async commitDatabase(input) {
      await beforeOperation?.();
      return database.commit(input);
    },

    async getChannels(): Promise<readonly ChannelRow[]> {
      await beforeOperation?.();
      return client.getChannels();
    },

    async insertChannel(input) {
      await beforeOperation?.();
      return database.models.channels.insert(input);
    },

    async deleteChannel(input) {
      await beforeOperation?.();
      return database.models.channels.delete(input);
    },

    async getBundles(options) {
      await beforeOperation?.();
      return client.getBundles(options);
    },

    async insertBundle(bundle: LegacyBundle): Promise<void> {
      await beforeOperation?.();
      assertBundlePersistenceConstraints(bundle);
      const { scope } = await resolveLegacyReleaseScope(
        database,
        authorityId,
        bundle,
      );
      const rows = await readLegacyScopeReleases(database, scope.scopeKey);
      await commitReleaseCatalogMutation({
        companionChanges: bundleInsertChanges(bundle, scope.channelId),
        database,
        mutation: {
          operation: "insert",
          row: createLegacyRelease(bundle, scope, rows),
        },
        scope,
      });
    },

    async insertBundles(bundles: readonly LegacyBundle[]): Promise<void> {
      await beforeOperation?.();
      for (const bundle of bundles) {
        assertBundlePersistenceConstraints(bundle);
      }
      const channels = new Map(
        (await database.models.channels.list({})).channels.map((channel) => [
          channel.name,
          channel,
        ]),
      );
      const mutations: ReleaseCatalogMutationInput[] = [];
      for (const bundle of bundles) {
        const { scope } = await resolveLegacyReleaseScope(
          database,
          authorityId,
          bundle,
          [...channels.values()],
        );
        channels.set(scope.channelName, {
          id: scope.channelId,
          name: scope.channelName,
        });
        const rows = await readLegacyScopeReleases(database, scope.scopeKey);
        mutations.push({
          companionChanges: [...bundleInsertChanges(bundle, scope.channelId)],
          mutation: {
            operation: "insert",
            row: createLegacyRelease(bundle, scope, rows),
          },
          scope,
        });
      }
      await commitReleaseCatalogMutations({ database, mutations });
    },

    async updateBundleById(
      bundleId: string,
      update: Partial<LegacyBundle>,
    ): Promise<void> {
      await beforeOperation?.();
      const artifact = await client.getBundleById(bundleId);
      if (!artifact) throw new Error("targetBundleId not found");
      const release = (
        await database.models.releases.findMany({ bundleId, limit: 1 })
      )[0];
      if (release === undefined) {
        throw new Error(
          "Bundle has no Release policy; use the Release API to create one.",
        );
      }
      const channel = (await client.getChannels()).find(
        ({ id }) => id === release.channel_id,
      );
      if (channel === undefined) {
        throw new Error(
          `Release channel "${release.channel_id}" was not found.`,
        );
      }
      const current: LegacyBundle = {
        ...artifact,
        channel: channel.name,
        enabled: release.enabled,
        fingerprintHash: release.fingerprint_hash,
        message: release.message,
        rolloutCohortCount: release.rollout_cohort_count,
        shouldForceUpdate: release.should_force_update,
        targetAppVersion: release.target_app_version,
        targetCohorts: [...release.target_cohorts],
      };
      const nextBundle: LegacyBundle = {
        ...current,
        ...update,
        id: bundleId,
      };
      assertBundlePersistenceConstraints(nextBundle);
      if (
        nextBundle.channel !== current.channel ||
        nextBundle.platform !== current.platform ||
        nextBundle.fingerprintHash !== current.fingerprintHash
      ) {
        throw new Error(
          "Legacy Bundle updates cannot move Release catalog scope; use the Release API.",
        );
      }
      const { scope } = await resolveLegacyReleaseScope(
        database,
        authorityId,
        current,
      );
      const companionChanges = bundleUpdateChanges(
        nextBundle,
        scope.channelId,
        Object.hasOwn(update, "patches"),
      );
      await commitReleaseCatalogMutation({
        companionChanges,
        database,
        mutation: {
          id: release.id,
          operation: "update",
          update: {
            enabled: nextBundle.enabled,
            fingerprint_hash: nextBundle.fingerprintHash,
            message: nextBundle.message,
            rollout_cohort_count: nextBundle.rolloutCohortCount ?? 1_000,
            should_force_update: nextBundle.shouldForceUpdate,
            target_app_version: nextBundle.targetAppVersion,
            target_cohorts: nextBundle.targetCohorts ?? [],
            updated_at_ms: Date.now(),
          },
        },
        scope,
      });
    },

    async deleteBundleById(bundleId: string): Promise<void> {
      await beforeOperation?.();
      await client.deleteBundleById(bundleId);
    },
  };

  return {
    api,
    adapterName: database.name,
    createMigrator: () => {
      throw new Error(
        "createMigrator is only available for Kysely/MongoDB database plugins.",
      );
    },
    generateSchema: () => {
      throw new Error(
        "generateSchema is only available for Drizzle/Prisma database plugins.",
      );
    },
  };
}
