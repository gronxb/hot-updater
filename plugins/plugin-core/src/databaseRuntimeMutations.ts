import type { DatabasePluginCore } from "./databaseCoreTypes";
import {
  deleteCoreBundlePatch,
  insertCoreBundlePatch,
  updateCoreBundlePatch,
} from "./databaseRuntimePatches";
import type { DatabaseMutation } from "./types";

export const assertSupportedBatch = (
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

export const applyMutations = async (
  core: DatabasePluginCore,
  mutations: readonly DatabaseMutation[],
): Promise<void> => {
  for (const mutation of mutations) {
    if (mutation.kind === "bundlePatch.delete") {
      await deleteCoreBundlePatch(core.bundlePatches, mutation.patchId);
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
    if (mutation.kind === "bundlePatch.insert") {
      await insertCoreBundlePatch(core.bundlePatches, mutation.patch);
    }
  }
  for (const mutation of mutations) {
    if (mutation.kind === "bundlePatch.update") {
      await updateCoreBundlePatch(
        core.bundlePatches,
        mutation.patchId,
        mutation.patch,
      );
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
