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

const PATCH_OVERLAY_LOOKUP_LIMIT = 1000;

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

const createOverlayPagination = <TData>(
  page: CursorPage<TData>,
  data: readonly TData[],
  options: {
    readonly limit: number;
    readonly total: number;
    readonly fullDataLength: number;
    readonly getCursor: (item: TData) => string | null | undefined;
    readonly preferPageCursors?: boolean;
  },
): CursorPage<TData>["pagination"] => {
  const total = Math.max(0, options.total);
  const nextCursor = data.at(-1) ? options.getCursor(data.at(-1)!) : null;
  const previousCursor = data[0] ? options.getCursor(data[0]) : null;
  const currentPage = Math.max(1, page.pagination.currentPage ?? 1);
  const startOffset = options.limit > 0 ? (currentPage - 1) * options.limit : 0;
  const hasNextPage = options.preferPageCursors
    ? page.pagination.hasNextPage || options.fullDataLength > options.limit
    : startOffset + data.length < total;
  const pageNextCursor = options.preferPageCursors
    ? page.pagination.nextCursor
    : null;
  const pagePreviousCursor = options.preferPageCursors
    ? page.pagination.previousCursor
    : null;
  return {
    ...page.pagination,
    total,
    totalPages:
      options.limit > 0 && total > 0 ? Math.ceil(total / options.limit) : 0,
    hasNextPage,
    hasPreviousPage: page.pagination.hasPreviousPage,
    nextCursor: hasNextPage ? (pageNextCursor ?? nextCursor ?? null) : null,
    previousCursor: page.pagination.hasPreviousPage
      ? (pagePreviousCursor ?? previousCursor ?? null)
      : null,
  };
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

const getPatchId = (patch: DatabaseBundlePatch): string =>
  patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`;

const createEvent = (event: DatabaseBundleEventInput): DatabaseBundleEvent => ({
  ...event,
  id: createUUIDv7(),
});

class RuntimeStage {
  private readonly bundleEntries = new Map<string, BundleEntry>();
  private readonly bundleUpdates = new Map<
    string,
    Partial<DatabaseBundleRecord>
  >();
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
        this.bundleUpdates.delete(mutation.bundle.id);
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
        } else if (entry?.kind !== "deleted") {
          this.bundleUpdates.set(mutation.bundleId, {
            ...this.bundleUpdates.get(mutation.bundleId),
            ...mutation.patch,
          });
        }
        this.mutations.push(mutation);
        return;
      }
      case "bundle.delete":
        this.bundleEntries.set(mutation.bundleId, { kind: "deleted" });
        this.bundleUpdates.delete(mutation.bundleId);
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

  private applyBundleUpdate(
    bundle: DatabaseBundleRecord,
  ): DatabaseBundleRecord {
    const patch = this.bundleUpdates.get(bundle.id);
    return patch ? { ...bundle, ...patch } : bundle;
  }

  async resolveBundle(
    core: DatabasePluginCore,
    bundleId: string,
  ): Promise<DatabaseBundleRecord | null | undefined> {
    const entry = this.bundleEntries.get(bundleId);
    const staged = resolveBundleEntry(entry);
    if (staged !== undefined) {
      return staged;
    }
    if (!this.bundleUpdates.has(bundleId)) {
      return undefined;
    }
    const current = await core.bundles.getById({ bundleId });
    return current ? this.applyBundleUpdate(current) : null;
  }

  async overlayBundles(
    core: DatabasePluginCore,
    page: CursorPage<DatabaseBundleRecord>,
    query: BundleListQuery,
  ): Promise<CursorPage<DatabaseBundleRecord>> {
    const hasBundleMutations =
      this.bundleEntries.size > 0 || this.bundleUpdates.size > 0;
    const byId = new Map<string, DatabaseBundleRecord>();
    const baseById = new Map(page.data.map((bundle) => [bundle.id, bundle]));
    let total = page.pagination.total ?? page.data.length;

    for (const bundle of page.data) {
      const overlaidBundle = this.applyBundleUpdate(bundle);
      if (bundleMatches(overlaidBundle, query)) {
        byId.set(bundle.id, overlaidBundle);
      } else {
        byId.delete(bundle.id);
        total -= 1;
      }
    }

    for (const [bundleId, patch] of this.bundleUpdates) {
      if (baseById.has(bundleId) || this.bundleEntries.has(bundleId)) {
        continue;
      }
      const current = await core.bundles.getById({ bundleId });
      if (!current) {
        continue;
      }
      const overlaidBundle = { ...current, ...patch };
      const beforeMatches = bundleMatches(current, query);
      const afterMatches = bundleMatches(overlaidBundle, query);
      if (!beforeMatches && afterMatches) {
        total += 1;
      } else if (beforeMatches && !afterMatches) {
        total -= 1;
      }
      if (!beforeMatches && afterMatches) {
        byId.set(bundleId, overlaidBundle);
      }
    }

    for (const [bundleId, entry] of this.bundleEntries) {
      const baseBundle = baseById.get(bundleId);
      const beforeMatches = baseBundle
        ? bundleMatches(baseBundle, query)
        : await core.bundles
            .getById({ bundleId })
            .then((bundle) => (bundle ? bundleMatches(bundle, query) : false));
      if (entry.kind === "deleted") {
        byId.delete(bundleId);
        if (beforeMatches) {
          total -= 1;
        }
        continue;
      }
      if (bundleMatches(entry.bundle, query)) {
        byId.set(bundleId, entry.bundle);
        if (!beforeMatches) {
          total += 1;
        }
      } else {
        byId.delete(bundleId);
        if (beforeMatches) {
          total -= 1;
        }
      }
    }
    const direction = query.orderBy?.direction ?? "desc";
    const fullData = Array.from(byId.values()).sort((left, right) =>
      compareStrings(left.id, right.id, direction),
    );
    const data = fullData.slice(0, query.limit);
    return {
      ...page,
      data,
      pagination: createOverlayPagination(page, data, {
        limit: query.limit,
        total,
        fullDataLength: fullData.length,
        getCursor: (bundle) => bundle.id,
        preferPageCursors: !hasBundleMutations,
      }),
    };
  }

  private async listCurrentPatches(
    core: DatabasePluginCore,
    where: NonNullable<BundlePatchListQuery["where"]>,
  ): Promise<DatabaseBundlePatch[]> {
    const patches: DatabaseBundlePatch[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await core.bundlePatches.list({
        where,
        limit: PATCH_OVERLAY_LOOKUP_LIMIT,
        cursor: after ? { after } : undefined,
      });
      patches.push(...page.data.map(materializePatch));
      if (!page.pagination.hasNextPage || !page.pagination.nextCursor) {
        return patches;
      }
      after = page.pagination.nextCursor;
    }
  }

  async overlayPatches(
    core: DatabasePluginCore,
    page: CursorPage<DatabaseBundlePatch>,
    query: BundlePatchListQuery,
  ): Promise<CursorPage<DatabaseBundlePatch>> {
    const byId = new Map(
      page.data.map((patch) => [getPatchId(patch), materializePatch(patch)]),
    );
    const hasPatchMutations =
      this.deletedPatchBundleIds.size > 0 ||
      this.deletedPatchBaseBundleIds.size > 0 ||
      this.bundlePatchReplacements.size > 0;
    const currentMatchingPatchIds = new Set<string>();
    const removedPatchIds = new Set<string>();
    let total = page.pagination.total ?? page.data.length;
    const removePatch = (patch: DatabaseBundlePatch) => {
      const patchId = getPatchId(patch);
      byId.delete(patchId);
      if (patchMatches(patch, query)) {
        currentMatchingPatchIds.add(patchId);
      }
      if (
        currentMatchingPatchIds.has(patchId) &&
        !removedPatchIds.has(patchId)
      ) {
        removedPatchIds.add(patchId);
        total -= 1;
      }
    };
    const addPatch = (patch: DatabaseBundlePatch) => {
      const patchId = getPatchId(patch);
      byId.set(patchId, patch);
      if (
        patchMatches(patch, query) &&
        (removedPatchIds.has(patchId) || !currentMatchingPatchIds.has(patchId))
      ) {
        total += 1;
      }
      removedPatchIds.delete(patchId);
    };
    for (const bundleId of this.deletedPatchBundleIds) {
      for (const patch of await this.listCurrentPatches(core, { bundleId })) {
        removePatch(patch);
      }
    }
    for (const baseBundleId of this.deletedPatchBaseBundleIds) {
      for (const patch of await this.listCurrentPatches(core, {
        baseBundleId,
      })) {
        removePatch(patch);
      }
    }
    for (const [bundleId, patches] of this.bundlePatchReplacements) {
      for (const patch of await this.listCurrentPatches(core, { bundleId })) {
        removePatch(patch);
      }
      for (const patch of patches) {
        addPatch(patch);
      }
    }
    const data = Array.from(byId.values())
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
      });
    const pageData = data.slice(0, query.limit);
    return {
      ...page,
      data: pageData,
      pagination: createOverlayPagination(page, pageData, {
        limit: query.limit,
        total,
        fullDataLength: data.length,
        getCursor: (patch) =>
          patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`,
        preferPageCursors: !hasPatchMutations,
      }),
    };
  }

  overlayEvents(
    page: CursorPage<DatabaseBundleEvent>,
    query: BundleEventListQuery,
  ): CursorPage<DatabaseBundleEvent> {
    const byId = new Map(page.data.map((event) => [event.id, event]));
    const baseEventIds = new Set(byId.keys());
    let total = page.pagination.total ?? page.data.length;
    for (const event of this.eventAppends) {
      if (eventMatches(event, query)) {
        byId.set(event.id, event);
        if (!baseEventIds.has(event.id)) {
          total += 1;
        }
      }
    }
    const direction = query.orderBy?.direction ?? "desc";
    const data = Array.from(byId.values()).sort((left, right) =>
      compareStrings(left.id, right.id, direction),
    );
    const pageData = data.slice(0, query.limit);
    return {
      ...page,
      data: pageData,
      pagination: createOverlayPagination(page, pageData, {
        limit: query.limit,
        total,
        fullDataLength: data.length,
        getCursor: (event) => event.id,
        preferPageCursors: this.eventAppends.length === 0,
      }),
    };
  }

  snapshot(): readonly DatabaseMutation[] {
    return this.mutations.slice();
  }

  clear(): void {
    this.bundleEntries.clear();
    this.bundleUpdates.clear();
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
      try {
        await transaction?.rollback();
      } finally {
        stage.clear();
      }
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
        const page = await core.bundles.list(params);
        return stage.overlayBundles(core, page, params);
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
        return stage.overlayPatches(core, page, params);
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
