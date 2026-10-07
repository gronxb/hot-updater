import type {
  CatalogHighWater,
  PersistedSelectionReceipt,
} from "@hot-updater/protocol";
import { HotUpdater, insights, remoteConfig } from "@hot-updater/react-native";
import { TurboModuleRegistry, type TurboModule } from "react-native";
import { proxy } from "valtio";

import { HOT_UPDATER_API_KEY } from "../e2eBuildConfig";
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
  readonly catalogId: string | null;
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
  readonly manifest: ReturnType<typeof hotUpdater.getManifest>;
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

// One plugin object per runtime: init again keeps its state and its API.
const analytics = insights();
// The Remote Config scenario's parameters, with the defaults the app ships.
// It fetches every time it is asked, so a scenario never waits out an interval.
const remoteConfigPlugin = remoteConfig({
  defaults: { e2e_flag: true, e2e_limit: 1, e2e_message: "in-app default" },
  minimumFetchIntervalMs: 0,
});

// Runs at startup, and again from an E2E action as a root that initializes Hot
// Updater when it mounts does. Each run shows its own read of this launch.
export const initializeHotUpdater = () => {
  notify.status = undefined;
  notify.fromBundleId = undefined;
  notify.fromReleaseId = undefined;
  notify.toBundleId = undefined;
  notify.toReleaseId = undefined;
  return HotUpdater.init({
    plugins: [analytics, remoteConfigPlugin],
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
};

export const hotUpdater = initializeHotUpdater();

// Console Insights QA looks installations up by this user ID.
hotUpdater.insights.setUser({ userId: "detox-e2e" });

// The Remote Config scenario reads its values through this plugin.
export const e2eRemoteConfig = hotUpdater.remoteConfig;

export const readRuntimeSnapshot = (): RuntimeSnapshot => ({
  activeReleaseId: null,
  appVersion: hotUpdater.getAppVersion(),
  catalogId: null,
  baseURL: fallbackHotUpdaterBaseURL,
  bundleId: hotUpdater.getManifest().bundleId,
  channel: hotUpdater.getChannel(),
  cohort: hotUpdater.getCohort(),
  crashHistory: hotUpdater.getCrashHistory(),
  defaultChannel: hotUpdater.getDefaultChannel(),
  fingerprintHash: hotUpdater.getFingerprintHash(),
  generation: null,
  highWater: "{}",
  isChannelSwitched: hotUpdater.isChannelSwitched(),
  manifest: hotUpdater.getManifest(),
  minBundleId: hotUpdater.getMinBundleId(),
  scopeKey: null,
  selectionContextHash: null,
  selectionKind: null,
});

export const refreshRuntimeSnapshot = async (): Promise<RuntimeSnapshot> => {
  // E2E diagnostics deliberately inspect the native protocol, not the public SDK state.
  const rawState = TurboModuleRegistry.getEnforcing<
    TurboModule & {
      getActiveUpdateState(): unknown;
    }
  >("HotUpdater").getActiveUpdateState();
  const internalState = (
    typeof rawState === "string" ? JSON.parse(rawState) : rawState
  ) as {
    activeSelection: PersistedSelectionReceipt | null;
    highestSeenCatalogs: Readonly<Record<string, CatalogHighWater>>;
  };
  const [baseURL, updateState] = await Promise.all([
    resolveHotUpdaterBaseURL(),
    Promise.resolve(internalState),
  ]);
  const active = updateState.activeSelection;
  return {
    ...readRuntimeSnapshot(),
    activeReleaseId: active?.releaseId ?? null,
    catalogId: active?.catalogId ?? null,
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
