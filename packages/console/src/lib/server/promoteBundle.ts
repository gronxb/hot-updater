import { stripBundleArtifactMetadata } from "@hot-updater/core";
import type {
  Bundle,
  DatabasePlugin,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { createUUIDv7 } from "@hot-updater/plugin-core";

export interface PromoteBundleInput {
  action: "copy" | "move";
  bundleId: string;
  nextBundleId?: string;
  targetChannel: string;
}

export interface PromoteBundleDependencies {
  databasePlugin: DatabasePlugin;
  storagePlugin: StoragePlugin;
}

export async function promoteBundle(
  { action, bundleId, nextBundleId, targetChannel }: PromoteBundleInput,
  deps: PromoteBundleDependencies,
) {
  const normalizedTargetChannel = targetChannel.trim();
  if (!normalizedTargetChannel) {
    throw new Error("Target channel is required");
  }

  const bundle = await deps.databasePlugin.getBundleById(bundleId);
  if (!bundle) {
    throw new Error("Bundle not found");
  }

  if (bundle.channel === normalizedTargetChannel) {
    throw new Error(
      "Target channel must be different from the current channel",
    );
  }

  if (action === "move") {
    await deps.databasePlugin.updateBundle(bundleId, {
      channel: normalizedTargetChannel,
    });
    await deps.databasePlugin.commitBundle();

    const updatedBundle = await deps.databasePlugin.getBundleById(bundleId);
    if (!updatedBundle) {
      throw new Error("Promoted bundle not found");
    }

    return updatedBundle;
  }

  const copiedBundle: Bundle = {
    ...bundle,
    id: nextBundleId?.trim() || createUUIDv7(),
    channel: normalizedTargetChannel,
    metadata: stripBundleArtifactMetadata(bundle.metadata),
    patches: [],
    patchBaseBundleId: null,
    patchBaseFileHash: null,
    patchFileHash: null,
    patchStorageUri: null,
  };

  await deps.databasePlugin.appendBundle(copiedBundle);
  await deps.databasePlugin.commitBundle();

  return copiedBundle;
}
