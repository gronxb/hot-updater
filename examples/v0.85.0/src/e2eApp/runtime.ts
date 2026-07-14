import { HotUpdater } from "@hot-updater/react-native";
import { proxy } from "valtio";

import {
  fallbackHotUpdaterBaseURL,
  resolveHotUpdaterBaseURL,
} from "../e2eRuntimeConfig";

export const E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH =
  "assets/src/test/_fixture-archive-300mb-random.bmp";

export const notify = proxy<{
  crashedBundleId?: string;
  status?: string;
}>({});

export type RuntimeSnapshot = {
  readonly appVersion: string | null;
  readonly baseURL: string;
  readonly bundleId: string;
  readonly channel: string;
  readonly cohort: string;
  readonly crashHistory: readonly string[];
  readonly defaultChannel: string;
  readonly fingerprintHash: string | null;
  readonly isChannelSwitched: boolean;
  readonly manifest: ReturnType<typeof HotUpdater.getManifest>;
  readonly minBundleId: string;
};

type UpdateProgressDetails = {
  readonly files: readonly {
    readonly downloadPath?: string;
    readonly path: string;
    readonly progress: number;
    readonly status: string;
  }[];
};

HotUpdater.setUser({
  userId: "detox-e2e",
  username: "hot-updater-e2e",
});

HotUpdater.init({
  analytics: true,
  baseURL: resolveHotUpdaterBaseURL,
  requestTimeout: 15000,
  onNotifyAppReady: (result) => {
    notify.status = result.status;
    notify.crashedBundleId = result.crashedBundleId;
  },
  onError: (error) => {
    console.error(error);
  },
});

export const readRuntimeSnapshot = (): RuntimeSnapshot => ({
  appVersion: HotUpdater.getAppVersion(),
  baseURL: fallbackHotUpdaterBaseURL,
  bundleId: HotUpdater.getBundleId(),
  channel: HotUpdater.getChannel(),
  cohort: HotUpdater.getCohort(),
  crashHistory: HotUpdater.getCrashHistory(),
  defaultChannel: HotUpdater.getDefaultChannel(),
  fingerprintHash: HotUpdater.getFingerprintHash(),
  isChannelSwitched: HotUpdater.isChannelSwitched(),
  manifest: HotUpdater.getManifest(),
  minBundleId: HotUpdater.getMinBundleId(),
});

export const refreshRuntimeSnapshot = async (): Promise<RuntimeSnapshot> => {
  const baseURL = await resolveHotUpdaterBaseURL();
  return { ...readRuntimeSnapshot(), baseURL };
};

export const extractFormatDateFromUUIDv7 = (uuid: string): string => {
  if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) {
    return "N/A";
  }

  const timestampHex = uuid.split("-").join("").slice(0, 12);
  const timestamp = Number.parseInt(timestampHex, 16);
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return "N/A";
  }

  const year = date.getFullYear().toString().slice(2);
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");

  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
};

const formatFallbackPercent = (value: number | null | undefined): string => {
  if (typeof value !== "number") {
    return "pending";
  }

  return `${Math.round(value * 100)}%`;
};

export const formatUpdateStoreDownloadPaths = (
  details: UpdateProgressDetails | null | undefined,
): string => {
  if (!details || details.files.length === 0) {
    return "none";
  }

  return details.files
    .map(
      (file) =>
        `${file.path}:${file.status}:${file.downloadPath}:${formatFallbackPercent(
          file.progress,
        )}`,
    )
    .join("\n");
};
