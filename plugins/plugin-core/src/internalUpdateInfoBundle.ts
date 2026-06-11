import type { Bundle, UpdateInfo } from "@hot-updater/core";

type UpdateInfoWithAttachedBundle = UpdateInfo & {
  readonly __hotUpdaterCurrentBundle?: Bundle | null;
  readonly __hotUpdaterBundle?: Bundle;
};

const attachBundleProperty = (
  info: UpdateInfoWithAttachedBundle,
  propertyName: "__hotUpdaterBundle" | "__hotUpdaterCurrentBundle",
  bundle: Bundle | null,
) => {
  Object.defineProperty(info, propertyName, {
    configurable: true,
    enumerable: false,
    value: bundle,
  });
};

export const attachBundlesToUpdateInfo = ({
  info,
  targetBundle,
}: {
  info: UpdateInfo;
  targetBundle: Bundle;
}): UpdateInfo => {
  const updateInfo: UpdateInfoWithAttachedBundle = info;
  attachBundleProperty(updateInfo, "__hotUpdaterBundle", targetBundle);
  return updateInfo;
};

export const attachMatchingBundlesToUpdateInfo = (
  info: UpdateInfo | null,
  bundles: readonly Bundle[],
  currentBundleId: string,
): UpdateInfo | null => {
  if (!info) {
    return null;
  }

  const targetBundle = bundles.find((candidate) => candidate.id === info.id);
  if (!targetBundle) {
    return info;
  }

  const currentBundle =
    bundles.find((candidate) => candidate.id === currentBundleId) ?? null;
  const updateInfo: UpdateInfoWithAttachedBundle = attachBundlesToUpdateInfo({
    info,
    targetBundle,
  });
  attachBundleProperty(
    updateInfo,
    "__hotUpdaterCurrentBundle",
    currentBundle,
  );
  return updateInfo;
};
