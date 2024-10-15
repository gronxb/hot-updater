import type { UpdateSource, UpdateSourceArg } from "@hot-updater/utils";
import { filterTargetVersion } from "@hot-updater/utils";
import { Platform } from "react-native";
import { getAppVersion, getBundleVersion } from "./native";
import { isNullable } from "./utils";
export type UpdateStatus = "ROLLBACK" | "UPDATE";

const findLatestSources = (sources: UpdateSource[]) => {
  return (
    sources
      ?.filter((item) => item.enabled)
      ?.sort((a, b) => b.bundleVersion - a.bundleVersion)?.[0] ?? null
  );
};

const checkForRollback = (
  sources: UpdateSource[],
  currentBundleVersion: number,
) => {
  const enabled = sources?.find(
    (item) => item.bundleVersion === currentBundleVersion,
  )?.enabled;
  const availableOldVersion = sources?.find(
    (item) => item.bundleVersion < currentBundleVersion && item.enabled,
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
  const currentBundleVersion = await getBundleVersion();

  const isRollback = checkForRollback(appVersionSources, currentBundleVersion);
  const latestSource = await findLatestSources(appVersionSources);

  if (!latestSource) {
    if (isRollback) {
      return {
        bundleVersion: 0,
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
      if (latestSource.bundleVersion === currentBundleVersion) {
        return null;
      }
      if (latestSource.bundleVersion > currentBundleVersion) {
        return {
          bundleVersion: latestSource.bundleVersion,
          forceUpdate: latestSource.forceUpdate,
          file: latestSource.file,
          hash: latestSource.hash,
          status: "UPDATE" as UpdateStatus,
        };
      }
      return {
        bundleVersion: latestSource.bundleVersion,
        forceUpdate: true,
        file: latestSource.file,
        hash: latestSource.hash,
        status: "ROLLBACK" as UpdateStatus,
      };
    }

  if (latestSource.bundleVersion > currentBundleVersion) {
    return {
      bundleVersion: latestSource.bundleVersion,
      forceUpdate: latestSource.forceUpdate,
      file: latestSource.file,
      hash: latestSource.hash,
      status: "UPDATE" as UpdateStatus,
    };
  }
  return null;
};
