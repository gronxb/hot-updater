import type {
  BundlePatchResource,
  DatabaseBundlePatch,
  DatabaseBundlePatchUpdate,
} from "./types";

export const materializePatch = (
  patch: DatabaseBundlePatch,
): DatabaseBundlePatch => {
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

export const getPatchId = (patch: DatabaseBundlePatch): string =>
  patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`;

export const getCoreBundlePatchById = async (
  resource: BundlePatchResource,
  patchId: string,
): Promise<DatabaseBundlePatch | null> => {
  const patch = await resource.getById({ patchId });
  return patch ? materializePatch(patch) : null;
};

export const insertCoreBundlePatch = async (
  resource: BundlePatchResource,
  patch: DatabaseBundlePatch,
): Promise<void> => {
  await resource.insert({ patch: materializePatch(patch) });
};

export const updateCoreBundlePatch = async (
  resource: BundlePatchResource,
  patchId: string,
  patch: DatabaseBundlePatchUpdate,
): Promise<void> => {
  await resource.update({ patchId, patch });
};

export const deleteCoreBundlePatch = async (
  resource: BundlePatchResource,
  patchId: string,
): Promise<void> => {
  await resource.delete({ patchId });
};
