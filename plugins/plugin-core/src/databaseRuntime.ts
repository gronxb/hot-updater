import type { DatabasePluginCore } from "./databaseCoreTypes";
import { overlayEvents } from "./databaseRuntimeEventOverlay";
import {
  listCoreBundleEvents,
  listCoreBundlePatches,
  listCoreBundles,
} from "./databaseRuntimeLists";
import {
  applyMutations,
  assertSupportedBatch,
} from "./databaseRuntimeMutations";
import { overlayBundles, overlayPatches } from "./databaseRuntimeOverlay";
import { getCoreBundlePatchById } from "./databaseRuntimePatches";
import { RuntimeStage } from "./databaseRuntimeStage";
import type {
  DatabaseBundleEventInput,
  DatabaseCommitParams,
  DatabasePluginHooks,
  DatabasePluginRuntime,
  RuntimeBundleEventRepository,
} from "./types";
import { createUUIDv7 } from "./uuidv7";

const createEvent = (event: DatabaseBundleEventInput) => ({
  ...event,
  id: event.id ?? createUUIDv7(),
});

export interface CreateDatabaseRuntimeOptions {
  readonly name: string;
  readonly getCore: () => Promise<DatabasePluginCore>;
  readonly hasBundleEvents: boolean;
  readonly hasBundleEventRetention: boolean;
  readonly hasUpdateInfo: boolean;
  readonly hooks?: DatabasePluginHooks;
  readonly close?: () => Promise<void>;
}

export const databaseRuntimeFactorySymbol = Symbol.for(
  "@hot-updater/plugin-core/database-runtime-factory",
);

export const createDatabaseRuntime = (
  options: CreateDatabaseRuntimeOptions,
): DatabasePluginRuntime => {
  const stage = new RuntimeStage();
  let commitQueue: Promise<void> = Promise.resolve();

  const performCommit = async (
    params: DatabaseCommitParams = {},
  ): Promise<void> => {
    const core = await options.getCore();
    const batchMutations = params.batch?.mutations ?? [];
    assertSupportedBatch(core, batchMutations);
    for (const mutation of batchMutations) {
      stage.stage(mutation);
    }
    const snapshot = stage.snapshot();
    if (snapshot.mutations.length === 0) {
      return;
    }

    const transaction = core.beginTransaction
      ? await core.beginTransaction()
      : null;
    try {
      await applyMutations(transaction?.core ?? core, snapshot.mutations);
      await transaction?.commit();
    } catch (error) {
      if (!transaction) {
        throw error;
      }
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Database mutation and rollback both failed.",
          { cause: error },
        );
      }
      throw error;
    }

    stage.acknowledge(snapshot);
    await options.hooks?.onDatabaseUpdated?.();
  };

  const commit = (params: DatabaseCommitParams = {}): Promise<void> => {
    const queuedCommit = commitQueue.then(() => performCommit(params));
    commitQueue = queuedCommit.catch(() => undefined);
    return queuedCommit;
  };

  const runtime: DatabasePluginRuntime = {
    name: options.name,
    bundles: {
      getById: async ({ bundleId }) => {
        const core = await options.getCore();
        const staged = await stage.resolveBundle(core, bundleId);
        if (staged !== undefined) {
          return staged;
        }
        return core.bundles.getById({ bundleId });
      },
      list: async (params) => {
        const core = await options.getCore();
        const page = await listCoreBundles(core, params);
        return overlayBundles(stage.overlayState(), core, page, params);
      },
      insert: async ({ bundle }) => {
        stage.stage({ kind: "bundle.insert", bundle });
      },
      update: async ({ bundleId, patch }) => {
        stage.stage({ kind: "bundle.update", bundleId, patch });
      },
      delete: async ({ bundleId }) => {
        stage.stage({ kind: "bundle.delete", bundleId });
      },
    },
    bundlePatches: {
      getById: async ({ patchId }) => {
        const core = await options.getCore();
        const staged = await stage.resolvePatch(core, patchId);
        if (staged !== undefined) {
          return staged;
        }
        return getCoreBundlePatchById(core.bundlePatches, patchId);
      },
      list: async (params) => {
        const core = await options.getCore();
        const page = await listCoreBundlePatches(core, params);
        return overlayPatches(stage.overlayState(), core, page, params);
      },
      insert: async ({ patch }) => {
        stage.stage({ kind: "bundlePatch.insert", patch });
      },
      update: async ({ patchId, patch }) => {
        stage.stage({ kind: "bundlePatch.update", patchId, patch });
      },
      delete: async ({ patchId }) => {
        stage.stage({ kind: "bundlePatch.delete", patchId });
      },
    },
    commit,
  };

  const ownedRuntime: DatabasePluginRuntime = options.close
    ? { ...runtime, close: options.close }
    : runtime;

  const runtimeWithUpdateInfo: DatabasePluginRuntime = options.hasUpdateInfo
    ? {
        ...ownedRuntime,
        updateInfo: {
          get: async (params) => {
            const core = await options.getCore();
            return core.updateInfo?.get(params) ?? null;
          },
        },
      }
    : ownedRuntime;

  if (options.hasBundleEvents) {
    const bundleEvents: RuntimeBundleEventRepository = {
      list: async (params) => {
        const core = await options.getCore();
        const page = await listCoreBundleEvents(core.bundleEvents, params);
        return overlayEvents(stage.overlayState(), page, params);
      },
      append: async ({ event }) => {
        stage.stage({
          kind: "bundleEvent.append",
          event: createEvent(event),
        });
      },
      ...(options.hasBundleEventRetention
        ? {
            deleteBeforeId: async (params) => {
              const core = await options.getCore();
              await core.bundleEvents?.deleteBeforeId?.(params);
            },
          }
        : {}),
    };
    return {
      ...runtimeWithUpdateInfo,
      bundleEvents,
    };
  }

  return runtimeWithUpdateInfo;
};
