import type { UpdateSource, UpdateSourceArg } from "@hot-updater/utils";
import { filterTargetVersion } from "@hot-updater/utils";
import { Platform } from "react-native";
import { getAppVersion, getBundleTimestamp } from "./native";
import { isNullable } from "./utils";
export type UpdateStatus = "ROLLBACK" | "UPDATE";

const findLatestSources = (sources: UpdateSource[]) => {
  return (
    sources
      ?.filter((item) => item.enabled)
      ?.sort((a, b) => b.bundleTimestamp - a.bundleTimestamp)?.[0] ?? null
  );
};

const checkForRollback = (
  sources: UpdateSource[],
  currentBundleTimestamp: number,
) => {
  const enabled = sources?.find(
    (item) => item.bundleTimestamp === currentBundleTimestamp,
  )?.enabled;
  const availableOldVersion = sources?.find(
    (item) => item.bundleTimestamp < currentBundleTimestamp && item.enabled,
  )?.enabled;

  if (isNullable(enabled)) {
    return availableOldVersion;
  }
  return !enabled;
};

const ensureUpdateSource = async (updateSource: UpdateSourceArg) => {
  let source: UpdateSource[] | null = null;
  if (typeof updateSource === "string") {
    if (updateSource.startsWith("http")) {
      const response = await fetch(updateSource);
      source = (await response.json()) as UpdateSource[];
    }
  } else if (typeof updateSource === "function") {
    source = await updateSource();
  } else {
    source = updateSource;
  }
  if (!source) {
    throw new Error("Invalid source");
  }
  return source;
};

export const checkForUpdate = async (updateSources: UpdateSourceArg) => {
  const sources = await ensureUpdateSource(updateSources);

  const currentAppVersion = await getAppVersion();
  const platform = Platform.OS as "ios" | "android";

  const appVersionSources = currentAppVersion
    ? filterTargetVersion(sources, currentAppVersion, platform)
    : [];
  const currentBundleTimestamp = await getBundleTimestamp();

  const isRollback = checkForRollback(
    appVersionSources,
    currentBundleTimestamp,
  );
  const latestSource = await findLatestSources(appVersionSources);

  if (!latestSource) {
    if (isRollback) {
      return {
        bundleTimestamp: 0,
        forceUpdate: true,
        file: null,
        hash: null,
        status: "ROLLBACK" as UpdateStatus,
      };
    }
    return null;
  }

  if (latestSource.file)
    if (isRollback) {
      if (latestSource.bundleTimestamp === currentBundleTimestamp) {
        return null;
      }
      if (latestSource.bundleTimestamp > currentBundleTimestamp) {
        return {
          bundleTimestamp: latestSource.bundleTimestamp,
          forceUpdate: latestSource.forceUpdate,
          file: latestSource.file,
          hash: latestSource.hash,
          status: "UPDATE" as UpdateStatus,
        };
      }
      return {
        bundleTimestamp: latestSource.bundleTimestamp,
        forceUpdate: true,
        file: latestSource.file,
        hash: latestSource.hash,
        status: "ROLLBACK" as UpdateStatus,
      };
    }

  if (latestSource.bundleTimestamp > currentBundleTimestamp) {
    return {
      bundleTimestamp: latestSource.bundleTimestamp,
      forceUpdate: latestSource.forceUpdate,
      file: latestSource.file,
      hash: latestSource.hash,
      status: "UPDATE" as UpdateStatus,
    };
  }
  return null;
};
