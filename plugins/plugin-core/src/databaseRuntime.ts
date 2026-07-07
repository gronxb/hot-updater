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
  DatabasePluginCore,
  DatabasePluginHooks,
  DatabasePluginRuntime,
  HotUpdaterContext,
  MaybePromise,
  RuntimeBundleEventRepository,
} from "./types";
import { createUUIDv7 } from "./uuidv7";

const createEvent = (event: DatabaseBundleEventInput) => ({
  ...event,
  id: createUUIDv7(),
});

export interface CreateDatabaseRuntimeOptions {
  readonly name: string;
  readonly getCore: () => Promise<DatabasePluginCore>;
  readonly hasBundleEvents: boolean;
  readonly hasUpdateInfo: boolean;
  readonly hooks?: DatabasePluginHooks;
}

export const databaseRuntimeFactorySymbol = Symbol.for(
  "@hot-updater/plugin-core/database-runtime-factory",
);

export type DatabaseRuntimeFactory = () => MaybePromise<DatabasePluginRuntime>;

export const databaseRuntimeOpenerSymbol = Symbol.for(
  "@hot-updater/plugin-core/database-runtime-opener",
);

export type DatabaseRuntimeOpener<TContext = unknown> = ((
  context?: HotUpdaterContext<TContext>,
) => MaybePromise<DatabasePluginRuntime>) & {
  readonly [databaseRuntimeOpenerSymbol]: true;
};

export const markDatabaseRuntimeOpener = <TContext = unknown>(
  openRuntime: (
    context?: HotUpdaterContext<TContext>,
  ) => MaybePromise<DatabasePluginRuntime>,
): DatabaseRuntimeOpener<TContext> =>
  Object.defineProperty(openRuntime, databaseRuntimeOpenerSymbol, {
    enumerable: false,
    value: true,
  }) as DatabaseRuntimeOpener<TContext>;

export const isDatabaseRuntimeOpener = <TContext = unknown>(
  value: unknown,
): value is DatabaseRuntimeOpener<TContext> =>
  typeof value === "function" &&
  (value as Partial<Record<typeof databaseRuntimeOpenerSymbol, boolean>>)[
    databaseRuntimeOpenerSymbol
  ] === true;

export type DatabaseRuntimeWithFactory<
  TCore extends DatabasePluginCore = DatabasePluginCore,
> = DatabasePluginRuntime & {
  readonly [databaseRuntimeFactorySymbol]: DatabaseRuntimeFactory;
  readonly __coreType?: TCore;
};

export const createDatabaseRuntime = (
  options: CreateDatabaseRuntimeOptions,
): DatabasePluginRuntime => {
  const stage = new RuntimeStage();

  const commit = async (params: DatabaseCommitParams = {}): Promise<void> => {
    const core = await options.getCore();
    const batchMutations = params.batch?.mutations ?? [];
    assertSupportedBatch(core, batchMutations);
    for (const mutation of batchMutations) {
      stage.stage(mutation);
    }
    const mutations = stage.snapshot();
    if (mutations.length === 0) {
      return;
    }

    const transaction = core.beginTransaction
      ? await core.beginTransaction()
      : null;
    try {
      await applyMutations(transaction?.core ?? core, mutations);
      await transaction?.commit();
    } catch (error) {
      await transaction?.rollback();
      throw error;
    }

    stage.clear();
    await options.hooks?.onDatabaseUpdated?.();
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
    close: async () => {
      const core = await options.getCore();
      await core.close?.();
    },
  };

  const runtimeWithUpdateInfo: DatabasePluginRuntime = options.hasUpdateInfo
    ? {
        ...runtime,
        updateInfo: {
          get: async (params) => {
            const core = await options.getCore();
            return core.updateInfo?.get(params) ?? null;
          },
        },
      }
    : runtime;

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
    };
    return {
      ...runtimeWithUpdateInfo,
      bundleEvents,
    };
  }

  return runtimeWithUpdateInfo;
};
