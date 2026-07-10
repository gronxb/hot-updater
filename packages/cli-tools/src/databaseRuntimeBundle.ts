import type { Bundle } from "@hot-updater/core";
import {
  splitDatabaseBundle,
  toBundleReadModel,
  type DatabaseBundlePatch,
} from "@hot-updater/plugin-core";
import type { DatabasePluginRuntime } from "@hot-updater/plugin-core/internal";

const PATCH_PAGE_SIZE = 1000;
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

const listDatabaseRuntimeBundlePatches = async (
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

const replaceDatabaseRuntimeBundlePatches = async (
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
