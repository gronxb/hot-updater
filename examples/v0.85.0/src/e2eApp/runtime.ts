import { HOT_UPDATER_API_KEY } from "@env";
import { HotUpdater } from "@hot-updater/react-native";
import { proxy } from "valtio";

import {
  fallbackHotUpdaterBaseURL,
  resolveHotUpdaterBaseURL,
} from "../e2eRuntimeConfig";

export const E2E_LARGE_ARCHIVE_ASSET_MANIFEST_PATH =
  "assets/src/test/_fixture-archive-300mb-random.bmp";

export const notify = proxy<{
  fromBundleId?: string | null;
  fromReleaseId?: string | null;
  status?: string;
  toBundleId?: string | null;
  toReleaseId?: string | null;
}>({});

export type RuntimeSnapshot = {
  readonly activeReleaseId: string | null;
  readonly appVersion: string | null;
  readonly authorityId: string | null;
  readonly baseURL: string;
  readonly bundleId: string;
  readonly channel: string;
  readonly cohort: string;
  readonly crashHistory: readonly string[];
  readonly defaultChannel: string;
  readonly fingerprintHash: string | null;
  readonly generation: number | null;
  readonly highWater: string;
  readonly isChannelSwitched: boolean;
  readonly manifest: ReturnType<typeof HotUpdater.getManifest>;
  readonly minBundleId: string;
  readonly scopeKey: string | null;
  readonly selectionContextHash: string | null;
  readonly selectionKind: string | null;
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
  requestHeaders: HOT_UPDATER_API_KEY
    ? { "x-api-key": HOT_UPDATER_API_KEY }
    : undefined,
  requestTimeout: 15000,
  onNotifyAppReady: (result) => {
    notify.status = result.status;
    notify.fromBundleId = result.fromBundleId;
    notify.fromReleaseId = result.fromReleaseId;
    notify.toBundleId = result.toBundleId;
    notify.toReleaseId = result.toReleaseId;
  },
  onError: (error) => {
    console.error(error);
  },
});

export const readRuntimeSnapshot = (): RuntimeSnapshot => ({
  activeReleaseId: null,
  appVersion: HotUpdater.getAppVersion(),
  authorityId: null,
  baseURL: fallbackHotUpdaterBaseURL,
  bundleId: HotUpdater.getBundleId(),
  channel: HotUpdater.getChannel(),
  cohort: HotUpdater.getCohort(),
  crashHistory: HotUpdater.getCrashHistory(),
  defaultChannel: HotUpdater.getDefaultChannel(),
  fingerprintHash: HotUpdater.getFingerprintHash(),
  generation: null,
  highWater: "{}",
  isChannelSwitched: HotUpdater.isChannelSwitched(),
  manifest: HotUpdater.getManifest(),
  minBundleId: HotUpdater.getMinimumReleaseId(),
  scopeKey: null,
  selectionContextHash: null,
  selectionKind: null,
});

export const refreshRuntimeSnapshot = async (): Promise<RuntimeSnapshot> => {
  const [baseURL, updateState] = await Promise.all([
    resolveHotUpdaterBaseURL(),
    HotUpdater.getActiveUpdateState(),
  ]);
  const active = updateState.activeSelection;
  return {
    ...readRuntimeSnapshot(),
    activeReleaseId: active?.releaseId ?? null,
    authorityId: active?.authorityId ?? null,
    baseURL,
    generation: active?.generation ?? null,
    highWater: JSON.stringify(updateState.highestSeenCatalogs),
    scopeKey: active?.scopeKey ?? null,
    selectionContextHash: active?.selectionContextHash ?? null,
    selectionKind: active?.kind ?? null,
  };
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
