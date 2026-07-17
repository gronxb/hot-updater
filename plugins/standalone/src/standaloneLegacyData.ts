import type {
  Bundle,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  DatabaseImplementationResult,
  DatabaseModel,
} from "@hot-updater/plugin-core";
import {
  bundleToPatchRows,
  bundleToRow,
  createUUIDv7,
} from "@hot-updater/plugin-core";

import type { StandaloneBundleRemote } from "./standaloneBundleRemote";
import { StandaloneDatabaseError } from "./standaloneHttp";

export function loadRows(
  remote: StandaloneBundleRemote,
  model: "bundles",
): Promise<BundleRow[]>;
export function loadRows(
  remote: StandaloneBundleRemote,
  model: "bundle_patches",
): Promise<BundlePatchRow[]>;
export function loadRows(
  remote: StandaloneBundleRemote,
  model: "channels",
): Promise<ChannelRow[]>;
export async function loadRows(
  remote: StandaloneBundleRemote,
  model: DatabaseModel,
): Promise<DatabaseImplementationResult[]> {
  if (model === "channels") {
    return (await remote.loadChannels()).map((name) => ({ id: name, name }));
  }
  const bundles = await remote.loadBundles();
  return model === "bundles"
    ? bundles.map((bundle) => bundleToRow(bundle, bundle.channel))
    : bundles.flatMap(bundleToPatchRows);
}

export const persistChannel = async (
  remote: StandaloneBundleRemote,
  name: string,
): Promise<ChannelRow> => {
  if ((await remote.loadChannels()).includes(name)) {
    throw new StandaloneDatabaseError(
      "request-failed",
      `Channel ${name} already exists.`,
      409,
    );
  }
  const sentinelId = createUUIDv7();
  const sentinel: Bundle = {
    id: sentinelId,
    platform: "ios",
    shouldForceUpdate: false,
    enabled: false,
    fileHash: `channel:${name}`,
    gitCommitHash: null,
    message: null,
    channel: name,
    storageUri: `channel://${encodeURIComponent(name)}`,
    targetAppVersion: "*",
    fingerprintHash: null,
    metadata: {},
  };
  await remote.createBundle(sentinel);
  await remote.deleteBundle(sentinelId);
  return { id: name, name };
};
