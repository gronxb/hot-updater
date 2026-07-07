import type { Bundle } from "@hot-updater/plugin-core";

export const CONSOLE_OPERATION_KEYS = [
  "readChannels",
  "readBundles",
  "readBundle",
  "readBundleLineage",
  "updateBundle",
  "createBundle",
  "promoteBundleMove",
  "promoteBundleCopy",
  "deleteBundle",
  "downloadBundle",
] as const;

export type ConsoleOperationKey = (typeof CONSOLE_OPERATION_KEYS)[number];

export type ConsoleOperationCapability = {
  readonly supported: boolean;
  readonly reason: string | null;
};

export type ConsoleCapabilities = Record<
  ConsoleOperationKey,
  ConsoleOperationCapability
>;

export const consoleOperationLabels = {
  readChannels: "Read channels",
  readBundles: "Read bundles",
  readBundle: "Read bundle",
  readBundleLineage: "Read bundle lineage",
  updateBundle: "Update bundle",
  createBundle: "Create bundle",
  promoteBundleMove: "Move bundle",
  promoteBundleCopy: "Copy bundle",
  deleteBundle: "Delete bundle",
  downloadBundle: "Download bundle",
} satisfies Record<ConsoleOperationKey, string>;

export const getStorageUriProtocol = (storageUri: string) => {
  try {
    return new URL(storageUri).protocol.replace(":", "");
  } catch {
    return null;
  }
};

export const isDirectDownloadStorageUri = (storageUri: string | null) => {
  if (!storageUri) {
    return false;
  }

  const protocol = getStorageUriProtocol(storageUri);
  return protocol === "http" || protocol === "https";
};

export const isBundleDownloadSupported = (
  bundle: Pick<Bundle, "storageUri">,
  capabilities: ConsoleCapabilities,
) =>
  isDirectDownloadStorageUri(bundle.storageUri) ||
  capabilities.downloadBundle.supported;

export const createSupportedConsoleCapabilities = (): ConsoleCapabilities => ({
  readChannels: { supported: true, reason: null },
  readBundles: { supported: true, reason: null },
  readBundle: { supported: true, reason: null },
  readBundleLineage: { supported: true, reason: null },
  updateBundle: { supported: true, reason: null },
  createBundle: { supported: true, reason: null },
  promoteBundleMove: { supported: true, reason: null },
  promoteBundleCopy: { supported: true, reason: null },
  deleteBundle: { supported: true, reason: null },
  downloadBundle: { supported: true, reason: null },
});
