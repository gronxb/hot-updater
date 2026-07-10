import type { Bundle } from "@hot-updater/core";
import {
  splitDatabaseBundle,
  toBundleReadModel,
  type CursorPage,
  type DatabaseBundlePatch,
  type DatabaseBundleQueryOptions,
  type DatabaseBundleQueryOrder,
  type Paginated,
  type PaginationInfo,
} from "@hot-updater/plugin-core";
import type { DatabasePluginRuntime } from "@hot-updater/plugin-core/internal";

const PATCH_PAGE_SIZE = 1000;
const DEFAULT_ORDER = { field: "id", direction: "desc" } as const;
const PATCH_KEYS = [
  "patches",
  "patchBaseBundleId",
  "patchBaseFileHash",
  "patchFileHash",
  "patchStorageUri",
] as const satisfies readonly (keyof Bundle)[];

type BundleValidator = (bundle: Bundle) => void;

const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);

const hasPatchChange = (bundle: Partial<Bundle>): boolean =>
  PATCH_KEYS.some((key) => hasOwn(bundle, key));

const getPatchId = (patch: DatabaseBundlePatch): string =>
  patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`;

const sortBundles = (
  bundles: readonly Bundle[],
  orderBy: DatabaseBundleQueryOrder | undefined,
): Bundle[] => {
  const direction = orderBy?.direction ?? DEFAULT_ORDER.direction;
  return bundles.slice().sort((left, right) => {
    const result = left.id.localeCompare(right.id);
    return direction === "asc" ? result : -result;
  });
};

const toPagination = (
  page: CursorPage<unknown>,
  dataLength: number,
  limit: number,
): PaginationInfo => {
  const total = page.pagination.total ?? dataLength;
  return {
    total,
    currentPage: page.pagination.currentPage ?? 1,
    totalPages:
      page.pagination.totalPages ??
      (total === 0 ? 0 : Math.ceil(total / limit)),
    hasNextPage: page.pagination.hasNextPage,
    hasPreviousPage: page.pagination.hasPreviousPage,
    nextCursor: page.pagination.nextCursor,
    previousCursor: page.pagination.previousCursor,
  };
};

export const listDatabaseRuntimeBundlePatches = async (
  runtime: DatabasePluginRuntime,
  where: NonNullable<
    Parameters<DatabasePluginRuntime["bundlePatches"]["list"]>[0]["where"]
  >,
): Promise<DatabaseBundlePatch[]> => {
  const patches: DatabaseBundlePatch[] = [];
  let after: string | undefined;

  while (true) {
    const page = await runtime.bundlePatches.list({
      where,
      limit: PATCH_PAGE_SIZE,
      ...(after ? { cursor: { after } } : {}),
    });
    patches.push(...page.data);
    if (!page.pagination.hasNextPage) break;
    after =
      page.pagination.nextCursor ??
      page.data.at(-1)?.id ??
      page.data.at(-1)?.baseBundleId;
    if (!after) break;
  }

  return patches;
};

export const replaceDatabaseRuntimeBundlePatches = async (
  runtime: DatabasePluginRuntime,
  options: {
    readonly bundleId: string;
    readonly patches: readonly DatabaseBundlePatch[];
  },
): Promise<void> => {
  const current = await listDatabaseRuntimeBundlePatches(runtime, {
    bundleId: options.bundleId,
  });
  for (const patch of current) {
    await runtime.bundlePatches.delete({ patchId: getPatchId(patch) });
  }
  for (const patch of options.patches) {
    await runtime.bundlePatches.insert({ patch });
  }
};

export const readDatabaseRuntimeBundle = async (
  runtime: DatabasePluginRuntime,
  bundleId: string,
): Promise<Bundle | null> => {
  const record = await runtime.bundles.getById({ bundleId });
  if (!record) return null;
  const patches = await listDatabaseRuntimeBundlePatches(runtime, { bundleId });
  return toBundleReadModel(record, patches);
};

export const listDatabaseRuntimeBundles = async (
  runtime: DatabasePluginRuntime,
  options: DatabaseBundleQueryOptions,
): Promise<Paginated<Bundle[]>> => {
  const page = await runtime.bundles.list({
    ...options,
    orderBy: options.orderBy ?? DEFAULT_ORDER,
  });
  const ids = page.data.map((bundle) => bundle.id);
  const patches =
    ids.length === 0
      ? []
      : await listDatabaseRuntimeBundlePatches(runtime, { bundleIdIn: ids });
  const patchesByBundleId = new Map<string, DatabaseBundlePatch[]>();
  for (const patch of patches) {
    const group = patchesByBundleId.get(patch.bundleId);
    if (group) {
      group.push(patch);
    } else {
      patchesByBundleId.set(patch.bundleId, [patch]);
    }
  }
  const data = sortBundles(
    page.data.map((record) =>
      toBundleReadModel(record, patchesByBundleId.get(record.id) ?? []),
    ),
    options.orderBy ?? DEFAULT_ORDER,
  );
  return {
    data,
    pagination: toPagination(page, data.length, options.limit),
  };
};

export const stageDatabaseRuntimeBundleInsert = async (
  runtime: DatabasePluginRuntime,
  options: {
    readonly bundle: Bundle;
    readonly validate?: BundleValidator;
  },
): Promise<void> => {
  options.validate?.(options.bundle);
  const split = splitDatabaseBundle(options.bundle);
  await runtime.bundles.insert({ bundle: split.bundle });
  for (const patch of split.patches) {
    await runtime.bundlePatches.insert({ patch });
  }
};

export const stageDatabaseRuntimeBundleUpdate = async (
  runtime: DatabasePluginRuntime,
  options: {
    readonly bundleId: string;
    readonly patch: Partial<Bundle>;
    readonly validate?: BundleValidator;
  },
): Promise<Bundle> => {
  const current = await readDatabaseRuntimeBundle(runtime, options.bundleId);
  if (!current) throw new Error("targetBundleId not found");
  const updated = { ...current, ...options.patch };
  options.validate?.(updated);
  const split = splitDatabaseBundle(updated);
  await runtime.bundles.update({
    bundleId: options.bundleId,
    patch: split.bundle,
  });
  if (hasPatchChange(options.patch)) {
    await replaceDatabaseRuntimeBundlePatches(runtime, {
      bundleId: options.bundleId,
      patches: split.patches,
    });
  }
  return updated;
};

export const stageDatabaseRuntimeBundleDelete = async (
  runtime: DatabasePluginRuntime,
  bundleId: string,
): Promise<void> => {
  const patchesForBaseBundle = await listDatabaseRuntimeBundlePatches(runtime, {
    baseBundleId: bundleId,
  });
  for (const patch of patchesForBaseBundle) {
    await runtime.bundlePatches.delete({ patchId: getPatchId(patch) });
  }

  const patchesForBundle = await listDatabaseRuntimeBundlePatches(runtime, {
    bundleId,
  });
  for (const patch of patchesForBundle) {
    await runtime.bundlePatches.delete({ patchId: getPatchId(patch) });
  }

  await runtime.bundles.delete({ bundleId });
};
