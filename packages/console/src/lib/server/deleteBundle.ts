import type { DatabasePlugin, StoragePlugin } from "@hot-updater/plugin-core";

interface DeleteBundleInput {
  bundleId: string;
}

interface DeleteBundleDependencies {
  databasePlugin: DatabasePlugin;
  storagePlugin: StoragePlugin;
}

function resolveStorageUriForDeletion(
  storageUri: string,
  storagePlugin: StoragePlugin,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (protocol === "http" || protocol === "https") {
    return null;
  }

  if (storagePlugin.supportedProtocol !== protocol) {
    throw new Error(`No storage plugin for protocol: ${protocol}`);
  }

  return storageUri;
}

export async function deleteBundle(
  { bundleId }: DeleteBundleInput,
  { databasePlugin, storagePlugin }: DeleteBundleDependencies,
) {
  const bundle = await databasePlugin.getBundleById(bundleId);
  if (!bundle) {
    throw new Error("Bundle not found");
  }

  const storageUri = resolveStorageUriForDeletion(
    bundle.storageUri,
    storagePlugin,
  );

  await databasePlugin.deleteBundle(bundle);
  await databasePlugin.commitBundle();

  if (!storageUri) {
    return;
  }

  try {
    await storagePlugin.delete(storageUri);
  } catch (error) {
    console.error("Failed to delete bundle from storage:", error);
  }
}
