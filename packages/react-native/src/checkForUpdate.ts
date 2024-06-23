import type { UpdateSource, UpdateSourceArg } from "@hot-updater/internal";
import { getAppVersion, getBundleVersion } from "./native";
import { isNullable } from "./utils";

export type UpdateStatus = "ROLLBACK" | "UPDATE";

const findLatestSource = (source: UpdateSource[string]) => {
  return (
    source
      ?.filter((item) => item.enabled)
      ?.sort((a, b) => b.bundleVersion - a.bundleVersion)?.[0] ?? {
      bundleVersion: 0,
      forceUpdate: false,
    }
  );
};

const checkForRollback = (
  source: UpdateSource[string],
  currentBundleVersion: number,
) => {
  const enabled = source?.find(
    (item) => item.bundleVersion === currentBundleVersion,
  )?.enabled;
  const availableOldVersion = source?.find(
    (item) => item.bundleVersion < currentBundleVersion && item.enabled,
  )?.enabled;

  if (isNullable(enabled)) {
    return availableOldVersion;
  }
  return !enabled;
};

const ensureUpdateSource = async (updateSource: UpdateSourceArg) => {
  let source: UpdateSource | null = null;
  if (typeof updateSource === "string") {
    if (updateSource.startsWith("http")) {
      const response = await fetch(updateSource);
      source = (await response.json()) as UpdateSource;
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

export const checkForUpdate = async (updateSource: UpdateSourceArg) => {
  const source = await ensureUpdateSource(updateSource);

  const currentAppVersion = await getAppVersion();

  const appVersionSource = currentAppVersion ? source?.[currentAppVersion] : [];
  const currentBundleVersion = await getBundleVersion();

  const isRollback = checkForRollback(appVersionSource, currentBundleVersion);
  const latestSource = await findLatestSource(appVersionSource);

  if (isRollback) {
    if (latestSource.bundleVersion === currentBundleVersion) {
      return null;
    }
    if (latestSource.bundleVersion > currentBundleVersion) {
      return {
        bundleVersion: latestSource.bundleVersion,
        forceUpdate: latestSource.forceUpdate,
        files: latestSource.files,
        status: "UPDATE" as UpdateStatus,
      };
    }
    return {
      bundleVersion: latestSource.bundleVersion,
      forceUpdate: true,
      files: latestSource.files ?? [],
      status: "ROLLBACK" as UpdateStatus,
    };
  }

  if (latestSource.bundleVersion > currentBundleVersion) {
    return {
      bundleVersion: latestSource.bundleVersion,
      forceUpdate: latestSource.forceUpdate,
      files: latestSource.files,
      status: "UPDATE" as UpdateStatus,
    };
  }
  return null;
};
