import type {
  BundleEventListQuery,
  BundleListQuery,
  BundlePatchListQuery,
  CursorPage,
  DatabaseBundleEvent,
  DatabaseBundleEventInput,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
  DatabaseCommitParams,
  DatabaseMutation,
  DatabasePluginCore,
  DatabasePluginHooks,
  DatabasePluginRuntime,
  HotUpdaterContext,
  MaybePromise,
  RuntimeBundleEventRepository,
} from "./types";
import { createUUIDv7 } from "./uuidv7";

type BundleEntry =
  | {
      readonly kind: "present";
      readonly bundle: DatabaseBundleRecord;
    }
  | {
      readonly kind: "deleted";
    };

const emptyPagination = {
  hasNextPage: false,
  hasPreviousPage: false,
  nextCursor: null,
  previousCursor: null,
} as const;

const emptyPage = <TData>(): CursorPage<TData> => ({
  data: [],
  pagination: emptyPagination,
});

const resolveBundleEntry = (
  entry: BundleEntry | undefined,
): DatabaseBundleRecord | null | undefined => {
  if (!entry) {
    return undefined;
  }
  return entry.kind === "present" ? entry.bundle : null;
};

const compareStrings = (
  left: string,
  right: string,
  direction: "asc" | "desc",
) => {
  const result = left.localeCompare(right);
  return direction === "asc" ? result : -result;
};

const bundleMatches = (
  bundle: DatabaseBundleRecord,
  query: BundleListQuery,
): boolean => {
  const where = query.where;
  if (!where) {
    return true;
  }
  if (where.channel !== undefined && bundle.channel !== where.channel) {
    return false;
  }
  if (where.platform !== undefined && bundle.platform !== where.platform) {
    return false;
  }
  if (where.enabled !== undefined && bundle.enabled !== where.enabled) {
    return false;
  }
  if (where.targetAppVersion !== undefined) {
    if (bundle.targetAppVersion !== where.targetAppVersion) {
      return false;
    }
  }
  if (
    where.targetAppVersionIn !== undefined &&
    !where.targetAppVersionIn.includes(bundle.targetAppVersion ?? "")
  ) {
    return false;
  }
  if (
    where.targetAppVersionNotNull === true &&
    bundle.targetAppVersion === null
  ) {
    return false;
  }
  if (
    where.fingerprintHash !== undefined &&
    bundle.fingerprintHash !== where.fingerprintHash
  ) {
    return false;
  }
  const id = where.id;
  if (!id) {
    return true;
  }
  if (id.eq !== undefined && bundle.id !== id.eq) {
    return false;
  }
  if (id.gt !== undefined && bundle.id.localeCompare(id.gt) <= 0) {
    return false;
  }
  if (id.gte !== undefined && bundle.id.localeCompare(id.gte) < 0) {
    return false;
  }
  if (id.lt !== undefined && bundle.id.localeCompare(id.lt) >= 0) {
    return false;
  }
  if (id.lte !== undefined && bundle.id.localeCompare(id.lte) > 0) {
    return false;
  }
  return !(id.in !== undefined && !id.in.includes(bundle.id));
};

const patchMatches = (
  patch: DatabaseBundlePatch,
  query: BundlePatchListQuery,
): boolean => {
  const where = query.where;
  if (!where) {
    return true;
  }
  if (where.bundleId !== undefined && patch.bundleId !== where.bundleId) {
    return false;
  }
  if (
    where.baseBundleId !== undefined &&
    patch.baseBundleId !== where.baseBundleId
  ) {
    return false;
  }
  if (
    where.bundleIdIn !== undefined &&
    !where.bundleIdIn.includes(patch.bundleId)
  ) {
    return false;
  }
  return !(
    where.baseBundleIdIn !== undefined &&
    !where.baseBundleIdIn.includes(patch.baseBundleId)
  );
};

const eventMatches = (
  event: DatabaseBundleEvent,
  query: BundleEventListQuery,
): boolean => {
  const where = query.where;
  if (!where) {
    return true;
  }
  return (
    (where.kind === undefined || event.kind === where.kind) &&
    (where.installId === undefined || event.installId === where.installId) &&
    (where.activeBundleId === undefined ||
      event.activeBundleId === where.activeBundleId) &&
    (where.previousActiveBundleId === undefined ||
      event.previousActiveBundleId === where.previousActiveBundleId) &&
    (where.crashedBundleId === undefined ||
      event.crashedBundleId === where.crashedBundleId) &&
    (where.platform === undefined || event.platform === where.platform) &&
    (where.channel === undefined || event.channel === where.channel) &&
    (where.appVersion === undefined || event.appVersion === where.appVersion) &&
    (where.fingerprintHash === undefined ||
      event.fingerprintHash === where.fingerprintHash) &&
    (where.cohort === undefined || event.cohort === where.cohort)
  );
};

const materializePatch = (patch: DatabaseBundlePatch): DatabaseBundlePatch => {
  const expectedId = `${patch.bundleId}:${patch.baseBundleId}`;
  if (patch.id !== undefined && patch.id !== expectedId) {
    throw new Error(
      `Invalid bundle patch id. Expected '${expectedId}' for bundle '${patch.bundleId}'.`,
    );
  }
  return {
    ...patch,
    id: expectedId,
  };
};

const createEvent = (event: DatabaseBundleEventInput): DatabaseBundleEvent => ({
  ...event,
  id: createUUIDv7(),
});

class RuntimeStage {
  private readonly bundleEntries = new Map<string, BundleEntry>();
  private readonly bundlePatchReplacements = new Map<
    string,
    readonly DatabaseBundlePatch[]
  >();
  private readonly deletedPatchBundleIds = new Set<string>();
  private readonly deletedPatchBaseBundleIds = new Set<string>();
  private readonly eventAppends: DatabaseBundleEvent[] = [];
  private readonly mutations: DatabaseMutation[] = [];

  stage(mutation: DatabaseMutation): void {
    switch (mutation.kind) {
      case "bundle.insert":
        this.bundleEntries.set(mutation.bundle.id, {
          kind: "present",
          bundle: mutation.bundle,
        });
        this.mutations.push(mutation);
        return;
      case "bundle.update": {
        const entry = this.bundleEntries.get(mutation.bundleId);
        if (entry?.kind === "present") {
          this.bundleEntries.set(mutation.bundleId, {
            kind: "present",
            bundle: {
              ...entry.bundle,
              ...mutation.patch,
            },
          });
        }
        this.mutations.push(mutation);
        return;
      }
      case "bundle.delete":
        this.bundleEntries.set(mutation.bundleId, { kind: "deleted" });
        this.mutations.push(mutation);
        return;
      case "bundlePatch.replaceForBundle":
        this.bundlePatchReplacements.set(
          mutation.bundleId,
          mutation.patches.map(materializePatch),
        );
        this.deletedPatchBundleIds.delete(mutation.bundleId);
        this.mutations.push({
          ...mutation,
          patches: mutation.patches.map(materializePatch),
        });
        return;
      case "bundlePatch.deleteForBundle":
        this.deletedPatchBundleIds.add(mutation.bundleId);
        this.bundlePatchReplacements.delete(mutation.bundleId);
        this.mutations.push(mutation);
        return;
      case "bundlePatch.deleteForBaseBundle":
        this.deletedPatchBaseBundleIds.add(mutation.baseBundleId);
        this.mutations.push(mutation);
        return;
      case "bundleEvent.append":
        this.eventAppends.push(mutation.event);
        this.mutations.push(mutation);
        return;
    }
  }

  peekBundle(bundleId: string): DatabaseBundleRecord | null | undefined {
    return resolveBundleEntry(this.bundleEntries.get(bundleId));
  }

  overlayBundles(
    page: CursorPage<DatabaseBundleRecord>,
    query: BundleListQuery,
  ): CursorPage<DatabaseBundleRecord> {
    const byId = new Map(page.data.map((bundle) => [bundle.id, bundle]));
    for (const [bundleId, entry] of this.bundleEntries) {
      if (entry.kind === "deleted") {
        byId.delete(bundleId);
        continue;
      }
      if (bundleMatches(entry.bundle, query)) {
        byId.set(bundleId, entry.bundle);
      } else {
        byId.delete(bundleId);
      }
    }
    const direction = query.orderBy?.direction ?? "desc";
    return {
      ...page,
      data: Array.from(byId.values())
        .sort((left, right) => compareStrings(left.id, right.id, direction))
        .slice(0, query.limit),
    };
  }

  overlayPatches(
    page: CursorPage<DatabaseBundlePatch>,
    query: BundlePatchListQuery,
  ): CursorPage<DatabaseBundlePatch> {
    const byId = new Map(
      page.data.map((patch) => [
        patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`,
        materializePatch(patch),
      ]),
    );
    for (const bundleId of this.deletedPatchBundleIds) {
      for (const [patchId, patch] of byId) {
        if (patch.bundleId === bundleId) {
          byId.delete(patchId);
        }
      }
    }
    for (const baseBundleId of this.deletedPatchBaseBundleIds) {
      for (const [patchId, patch] of byId) {
        if (patch.baseBundleId === baseBundleId) {
          byId.delete(patchId);
        }
      }
    }
    for (const [bundleId, patches] of this.bundlePatchReplacements) {
      for (const patchId of Array.from(byId.keys())) {
        if (patchId.startsWith(`${bundleId}:`)) {
          byId.delete(patchId);
        }
      }
      for (const patch of patches) {
        byId.set(`${patch.bundleId}:${patch.baseBundleId}`, patch);
      }
    }
    return {
      ...page,
      data: Array.from(byId.values())
        .filter((patch) => patchMatches(patch, query))
        .slice()
        .sort((left, right) => {
          const direction = query.orderBy?.direction ?? "asc";
          const field = query.orderBy?.field ?? "orderIndex";
          if (field === "orderIndex") {
            const result = left.orderIndex - right.orderIndex;
            return direction === "asc" ? result : -result;
          }
          return compareStrings(left[field], right[field], direction);
        })
        .slice(0, query.limit),
    };
  }

  overlayEvents(
    page: CursorPage<DatabaseBundleEvent>,
    query: BundleEventListQuery,
  ): CursorPage<DatabaseBundleEvent> {
    const byId = new Map(page.data.map((event) => [event.id, event]));
    for (const event of this.eventAppends) {
      if (eventMatches(event, query)) {
        byId.set(event.id, event);
      }
    }
    const direction = query.orderBy?.direction ?? "desc";
    return {
      ...page,
      data: Array.from(byId.values())
        .sort((left, right) => compareStrings(left.id, right.id, direction))
        .slice(0, query.limit),
    };
  }

  snapshot(): readonly DatabaseMutation[] {
    return this.mutations.slice();
  }

  clear(): void {
    this.bundleEntries.clear();
    this.bundlePatchReplacements.clear();
    this.deletedPatchBundleIds.clear();
    this.deletedPatchBaseBundleIds.clear();
    this.eventAppends.splice(0);
    this.mutations.splice(0);
  }
}

const assertSupportedBatch = (
  core: DatabasePluginCore,
  mutations: readonly DatabaseMutation[],
): void => {
  if (
    core.bundleEvents === undefined &&
    mutations.some((mutation) => mutation.kind === "bundleEvent.append")
  ) {
    throw new Error("bundleEvents is not supported by this database provider.");
  }
};

const applyMutations = async (
  core: DatabasePluginCore,
  mutations: readonly DatabaseMutation[],
): Promise<void> => {
  for (const mutation of mutations) {
    if (mutation.kind === "bundlePatch.deleteForBaseBundle") {
      await core.bundlePatches.deleteForBaseBundle({
        baseBundleId: mutation.baseBundleId,
      });
    }
  }
  for (const mutation of mutations) {
    if (mutation.kind === "bundlePatch.deleteForBundle") {
      await core.bundlePatches.deleteForBundle({ bundleId: mutation.bundleId });
    }
  }
  for (const mutation of mutations) {
    if (mutation.kind === "bundle.delete") {
      await core.bundles.delete({ bundleId: mutation.bundleId });
    }
  }
  for (const mutation of mutations) {
    if (mutation.kind === "bundle.insert") {
      await core.bundles.insert({ bundle: mutation.bundle });
    }
  }
  for (const mutation of mutations) {
    if (mutation.kind === "bundle.update") {
      await core.bundles.update({
        bundleId: mutation.bundleId,
        patch: mutation.patch,
      });
    }
  }
  for (const mutation of mutations) {
    if (mutation.kind === "bundlePatch.replaceForBundle") {
      await core.bundlePatches.replaceForBundle({
        bundleId: mutation.bundleId,
        patches: mutation.patches,
      });
    }
  }
  for (const mutation of mutations) {
    if (mutation.kind === "bundleEvent.append") {
      const bundleEvents = core.bundleEvents;
      if (!bundleEvents) {
        throw new Error(
          "bundleEvents is not supported by this database provider.",
        );
      }
      await bundleEvents.append({ event: mutation.event });
    }
  }
};

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
        const staged = stage.peekBundle(bundleId);
        if (staged !== undefined) {
          return staged;
        }
        const core = await options.getCore();
        return core.bundles.getById({ bundleId });
      },
      list: async (params) => {
        const core = await options.getCore();
        const page = await core.bundles.list(params);
        return stage.overlayBundles(page, params);
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
      list: async (params) => {
        const core = await options.getCore();
        const page = await core.bundlePatches.list(params);
        return stage.overlayPatches(page, params);
      },
      replaceForBundle: async ({ bundleId, patches }) => {
        stage.stage({
          kind: "bundlePatch.replaceForBundle",
          bundleId,
          patches: patches.map(materializePatch),
        });
      },
      deleteForBundle: async ({ bundleId }) => {
        stage.stage({ kind: "bundlePatch.deleteForBundle", bundleId });
      },
      deleteForBaseBundle: async ({ baseBundleId }) => {
        stage.stage({
          kind: "bundlePatch.deleteForBaseBundle",
          baseBundleId,
        });
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
        const page = core.bundleEvents
          ? await core.bundleEvents.list(params)
          : emptyPage<DatabaseBundleEvent>();
        return stage.overlayEvents(page, params);
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
