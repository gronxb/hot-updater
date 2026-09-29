import {
  createReleaseCatalogScopeKey,
  decodeChannelKey,
  encodeChannelKey,
} from "@hot-updater/core";
import {
  bundleToPatchRows,
  bundleToRow,
  createUUIDv7After,
  DatabaseBundleNotFoundError,
  isUUIDv7,
  ReleaseCatalogMutationError,
  ReleaseManagementError,
  rowToBundle,
  type ChannelRow,
  type Deployment,
  type HotUpdaterCoreApi,
  type ReleaseCatalogMutationResult,
  type ReleaseCatalogScope,
  type ReleasePolicyPatch,
  type ReleaseRow,
  type ReleaseTarget,
} from "@hot-updater/plugin-core";
import { DatabaseRowReferencedError } from "@hot-updater/plugin-core/internal";

import { DatabaseConstraintError } from "../database/errors";
import {
  compiledGeneration,
  toBundleRow,
  toReleaseRow,
  type CoreDatabase,
} from "./reads";
import {
  changeRelease,
  changeReleases,
  readCatalog,
  rebuildScope,
  type ReleaseChangeResult,
} from "./releases";
import {
  deleteBundle,
  deleteChannel,
  insertChannel,
  replaceBundlePatches,
  updateBundle,
  type CoreTransaction,
} from "./writes";

type CoreOperations = Pick<
  HotUpdaterCoreApi,
  | "deploy"
  | "updateReleasePolicy"
  | "preflightReleasePolicy"
  | "deleteRelease"
  | "promoteRelease"
  | "rebuildReleaseCatalog"
  | "preflightReleaseCatalogRebuild"
  | "ensureChannel"
  | "deleteChannel"
  | "updateBundle"
  | "deleteBundles"
>;

/** Carries a preflight's result out of the transaction it stops, so nothing is written. */
class Preflight<T> extends Error {
  constructor(readonly result: T) {
    super("preflight");
  }
}

const dryRun = async <T>(
  db: CoreDatabase,
  read: (tx: CoreTransaction) => Promise<T>,
): Promise<T> => {
  try {
    await db.transaction(async (tx) => {
      throw new Preflight(await read(tx));
    });
  } catch (error) {
    if (error instanceof Preflight) return error.result as T;
    throw error;
  }
  throw new Error("A preflight transaction returned without its result.");
};

/** A channel's catalog scope for a platform, and a fingerprint when it has one. */
const scopeOf = (
  channel: ChannelRow,
  platform: "ios" | "android",
  fingerprintHash: string | null,
): ReleaseCatalogScope => {
  const channelKey = encodeChannelKey(channel.name);
  return fingerprintHash === null
    ? {
        channelId: channel.id,
        channelName: channel.name,
        fingerprintHash,
        platform,
        scopeKey: createReleaseCatalogScopeKey({
          channelKey,
          platform,
          strategy: "APP_VERSION",
        }),
        strategy: "APP_VERSION",
      }
    : {
        channelId: channel.id,
        channelName: channel.name,
        fingerprintHash,
        platform,
        scopeKey: createReleaseCatalogScopeKey({
          channelKey,
          fingerprintHash,
          platform,
          strategy: "FINGERPRINT",
        }),
        strategy: "FINGERPRINT",
      };
};

/** A release and its scope, checked against the revision the caller saw. */
const loadTarget = async (
  tx: CoreTransaction,
  { releaseId, expectedRevision }: ReleaseTarget,
) => {
  const row = await tx.findOne("releases", { id: releaseId });
  if (row === null) {
    throw new ReleaseManagementError(
      "RELEASE_NOT_FOUND",
      `Release "${releaseId}" was not found.`,
    );
  }
  const release = toReleaseRow(row);
  if (expectedRevision !== undefined && expectedRevision !== release.revision) {
    throw new ReleaseManagementError(
      "VERSION_CONFLICT",
      `Release "${release.id}" is revision ${release.revision}; expected ${expectedRevision}.`,
    );
  }
  const catalog = await tx.findOne("release_catalogs", {
    scope_key: release.scope_key,
  });
  if (catalog === null || compiledGeneration(catalog) === null) {
    throw new ReleaseCatalogMutationError(
      "INVALID_SCOPE",
      `Release "${release.id}" has no catalog projection.`,
    );
  }
  const scope: ReleaseCatalogScope = {
    channelId: release.channel_id,
    channelName: decodeChannelKey(catalog.channel_key),
    fingerprintHash: release.fingerprint_hash,
    platform: release.platform,
    scopeKey: release.scope_key,
    strategy: release.strategy,
  };
  return { release, scope };
};

const policyUpdate = (
  release: ReleaseRow,
  patch: ReleasePolicyPatch,
  updatedAtMs: number,
) => {
  if (
    patch.fingerprintHash !== undefined &&
    patch.fingerprintHash !== release.fingerprint_hash
  ) {
    throw new ReleaseManagementError(
      "SCOPE_MOVE_UNSUPPORTED",
      "Changing a fingerprint target requires an atomic Release scope move.",
    );
  }
  return {
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.message === undefined ? {} : { message: patch.message }),
    ...(patch.rolloutCohortCount === undefined
      ? {}
      : { rollout_cohort_count: patch.rolloutCohortCount }),
    ...(patch.shouldForceUpdate === undefined
      ? {}
      : { should_force_update: patch.shouldForceUpdate }),
    ...(patch.targetAppVersion === undefined
      ? {}
      : { target_app_version: patch.targetAppVersion }),
    ...(patch.targetCohorts === undefined
      ? {}
      : { target_cohorts: [...patch.targetCohorts] }),
    updated_at_ms: updatedAtMs,
  };
};

const mutationResult = ({
  catalog,
  release,
}: ReleaseChangeResult): ReleaseCatalogMutationResult => ({
  attempts: 1,
  catalog,
  release,
});

/** The scope a catalog row names, for a rebuild. */
const catalogScope = async (tx: CoreTransaction, scopeKey: string) => {
  const row = await tx.findOne("release_catalogs", { scope_key: scopeKey });
  if (row === null) {
    throw new Error(`Release catalog "${scopeKey}" was not found.`);
  }
  const scope: ReleaseCatalogScope = {
    channelId: row.channel_id,
    channelName: decodeChannelKey(row.channel_key),
    fingerprintHash: row.fingerprint_hash,
    platform: row.platform as "ios" | "android",
    scopeKey: row.scope_key,
    strategy: row.strategy as "APP_VERSION" | "FINGERPRINT",
  };
  return scope;
};

/**
 * Core's typed writes: each runs in one engine transaction rooted at the
 * catalogs it changes, so a concurrent change reruns it instead of
 * publishing a stale catalog.
 */
export const createCoreOperations = (
  db: CoreDatabase,
  { now = Date.now }: { readonly now?: () => number } = {},
): CoreOperations => {
  const ensureChannel = async (name: string): Promise<ChannelRow> =>
    (
      await insertChannel(db, {
        id: `channel:${encodeChannelKey(name)}`,
        name,
      })
    ).row;

  const deploy = async (
    deployments: readonly Deployment[],
  ): Promise<ReleaseCatalogMutationResult[]> => {
    const channels = new Map<string, ChannelRow>();
    for (const { release } of deployments) {
      if (!channels.has(release.channel)) {
        channels.set(release.channel, await ensureChannel(release.channel));
      }
    }
    // A stored bundle's platform comes from its row: one point read each.
    const platforms = new Map<string, ReleaseRow["platform"]>();
    for (const deployment of deployments) {
      if (!("bundleId" in deployment) || platforms.has(deployment.bundleId)) {
        continue;
      }
      const row = await db.findOne("bundles", { id: deployment.bundleId });
      if (row === null) {
        throw new DatabaseBundleNotFoundError(deployment.bundleId);
      }
      platforms.set(deployment.bundleId, toBundleRow(row).platform);
    }
    const updatedAtMs = now();
    const results = await changeReleases(
      db,
      deployments.map((deployment) => {
        const { release: policy } = deployment;
        const stored = "bundleId" in deployment;
        const bundleId = stored ? deployment.bundleId : deployment.bundle.id;
        const platform = stored
          ? platforms.get(deployment.bundleId)!
          : deployment.bundle.platform;
        const scope = scopeOf(
          channels.get(policy.channel)!,
          platform,
          policy.fingerprintHash,
        );
        return {
          scope,
          ...(stored
            ? {}
            : {
                bundle: {
                  row: bundleToRow(deployment.bundle),
                  patches: bundleToPatchRows(deployment.bundle),
                },
              }),
          change: {
            operation: "insert" as const,
            row: {
              bundle_id: bundleId,
              channel_id: scope.channelId,
              created_at_ms: updatedAtMs,
              enabled: policy.enabled,
              fingerprint_hash: policy.fingerprintHash,
              kind: "BUNDLE" as const,
              message: policy.message,
              operation: "DEPLOY" as const,
              platform,
              revision: 1,
              rollout_cohort_count: policy.rolloutCohortCount ?? 1_000,
              scope_key: scope.scopeKey,
              should_force_update: policy.shouldForceUpdate,
              source_release_id: null,
              strategy: scope.strategy,
              target_app_version: policy.targetAppVersion,
              target_cohorts: policy.targetCohorts ?? [],
              updated_at_ms: updatedAtMs,
            },
          },
          updatedAtMs,
        };
      }),
    );
    return results.map(mutationResult);
  };

  return {
    deploy,

    updateReleasePolicy: (input) => {
      const updatedAtMs = now();
      return db.transaction(async (tx) => {
        const { release, scope } = await loadTarget(tx, input);
        return mutationResult(
          await changeRelease(tx, {
            scope,
            change: {
              operation: "update",
              id: release.id,
              update: policyUpdate(release, input.patch, updatedAtMs),
            },
            updatedAtMs,
          }),
        );
      });
    },

    preflightReleasePolicy: (input) => {
      const updatedAtMs = now();
      return dryRun(db, async (tx) => {
        const { release, scope } = await loadTarget(tx, input);
        const stored = await readCatalog(tx, scope.scopeKey);
        const changed = await changeRelease(tx, {
          scope,
          change: {
            operation: "update",
            id: release.id,
            update: policyUpdate(release, input.patch, updatedAtMs),
          },
          updatedAtMs,
        });
        return {
          catalog: changed.catalog,
          currentCatalog: stored.catalog,
          diagnostics: changed.diagnostics,
          expectedReleaseRevision: release.revision,
          release: changed.release,
        };
      });
    },

    deleteRelease: (input) =>
      db.transaction(async (tx) => {
        const { release, scope } = await loadTarget(tx, input);
        if (release.enabled) {
          throw new ReleaseManagementError(
            "ENABLED_RELEASE",
            `Disable Release "${release.id}" before hard deletion.`,
          );
        }
        return mutationResult(
          await changeRelease(tx, {
            scope,
            change: { operation: "delete", id: release.id },
            updatedAtMs: now(),
          }),
        );
      }),

    promoteRelease: async (input) => {
      const checkSource = (source: ReleaseRow) => {
        if (source.kind !== "BUNDLE" || source.bundle_id === null) {
          throw new ReleaseManagementError(
            "TARGET_RELEASE_INVALID",
            "Only a Bundle Release can be promoted.",
          );
        }
      };
      // Check the source before the target channel is created.
      checkSource(
        (await db.transaction((tx) => loadTarget(tx, input))).release,
      );
      const targetChannel = input.targetChannel.trim();
      if (targetChannel.length === 0) {
        throw new ReleaseManagementError(
          "TARGET_RELEASE_INVALID",
          "Promotion requires a target channel.",
        );
      }
      const channel = await ensureChannel(targetChannel);
      const updatedAtMs = now();
      return db.transaction(async (tx) => {
        const { release: source, scope: sourceScope } = await loadTarget(
          tx,
          input,
        );
        checkSource(source);
        const targetScope = scopeOf(
          channel,
          source.platform,
          source.fingerprint_hash,
        );
        if (targetScope.scopeKey === sourceScope.scopeKey) {
          throw new ReleaseManagementError(
            "TARGET_RELEASE_INVALID",
            "Source and target Release scopes are the same.",
          );
        }
        const { rows } = await tx.findMany("releases", {
          index: "byScope",
          where: { scope_key: targetScope.scopeKey },
          order: "desc",
          limit: 1,
        });
        const floor = [rows[0]?.id ?? null, source.id, source.bundle_id]
          .filter((id): id is string => id !== null && isUUIDv7(id))
          .sort()
          .at(-1);
        const moved =
          input.action === "move"
            ? await changeRelease(tx, {
                scope: sourceScope,
                change: {
                  operation: "update",
                  id: source.id,
                  update: { enabled: false, updated_at_ms: updatedAtMs },
                },
                updatedAtMs,
              })
            : null;
        const target = await changeRelease(tx, {
          scope: targetScope,
          change: {
            operation: "insert",
            row: {
              ...source,
              id: createUUIDv7After(floor ?? null, updatedAtMs),
              revision: 1,
              scope_key: targetScope.scopeKey,
              channel_id: targetScope.channelId,
              enabled: true,
              rollout_cohort_count: 1_000,
              target_cohorts: [],
              operation: "PROMOTE",
              source_release_id: source.id,
              created_at_ms: updatedAtMs,
              updated_at_ms: updatedAtMs,
            },
          },
          updatedAtMs,
        });
        return {
          source: moved === null ? null : mutationResult(moved),
          target: mutationResult(target),
        };
      });
    },

    rebuildReleaseCatalog: (scopeKey) => {
      const updatedAtMs = now();
      return db.transaction(async (tx) => {
        const { current: _current, ...rebuilt } = await rebuildScope(
          tx,
          await catalogScope(tx, scopeKey),
          updatedAtMs,
        );
        return { attempts: 1, ...rebuilt };
      });
    },

    preflightReleaseCatalogRebuild: (scopeKey) => {
      const updatedAtMs = now();
      return dryRun(db, async (tx) => {
        const rebuilt = await rebuildScope(
          tx,
          await catalogScope(tx, scopeKey),
          updatedAtMs,
        );
        return {
          changed: rebuilt.changed,
          currentCatalog: rebuilt.current,
          diagnostics: rebuilt.diagnostics,
          projectedCatalog: rebuilt.catalog,
        };
      });
    },

    ensureChannel,

    deleteChannel: (id) => deleteChannel(db, id),

    updateBundle: (id, update) =>
      db.transaction(async (tx) => {
        const current = await tx.findOne("bundles", { id });
        if (current === null) throw new DatabaseBundleNotFoundError(id);
        const { patches, ...fields } = update;
        const next = { ...rowToBundle(toBundleRow(current)), ...fields, id };
        const { id: _id, ...set } = bundleToRow(next);
        updateBundle(tx, current, set);
        if (patches !== undefined) {
          await replaceBundlePatches(
            tx,
            current,
            bundleToPatchRows({ ...next, patches }),
          );
        }
      }),

    deleteBundles: async (ids) => {
      try {
        await db.transaction(async (tx) => {
          for (const id of new Set(ids)) {
            const current = await tx.findOne("bundles", { id });
            if (current !== null) await deleteBundle(tx, current);
          }
        });
      } catch (error) {
        if (
          error instanceof DatabaseConstraintError &&
          error.reason === "referenced"
        ) {
          throw new DatabaseRowReferencedError();
        }
        throw error;
      }
    },
  };
};
