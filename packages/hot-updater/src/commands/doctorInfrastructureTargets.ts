import { HOT_UPDATER_SERVER_VERSION } from "@hot-updater/server";
import { coerce, isLess, isLessOrEqual, isPrerelease, normalize } from "verkit";

import { INFRASTRUCTURE_UPDATES } from "./infrastructureUpdates";

export interface UpdateTarget {
  readonly version: string;
  readonly note: string;
}

export interface RequiredUpdateTarget extends UpdateTarget {
  readonly minimumPrereleaseVersion?: string;
}

export const UPDATE_TARGETS = INFRASTRUCTURE_UPDATES;

const getTargetAt = ({
  index,
  label,
  targets,
}: {
  index: number;
  label: string;
  targets: readonly UpdateTarget[];
}): UpdateTarget => {
  const target = targets.at(index);
  if (!target) {
    throw new Error(`${label} must not be empty`);
  }
  return target;
};

const getLatestKnownTargetVersion = () => {
  return getTargetAt({
    index: -1,
    label: "UPDATE_TARGETS",
    targets: UPDATE_TARGETS,
  }).version;
};

const getRequiredTarget = ({
  hotUpdaterVersion,
  targets,
}: {
  hotUpdaterVersion: string;
  targets: readonly UpdateTarget[];
}) => {
  const current = coerce(hotUpdaterVersion);

  if (!current) {
    return null;
  }

  let requiredTarget: UpdateTarget | null = null;

  for (const target of targets) {
    if (isLessOrEqual(target.version, current)) {
      requiredTarget = target;
    }
  }

  return (
    requiredTarget ??
    getTargetAt({
      index: 0,
      label: "UPDATE_TARGETS",
      targets,
    })
  );
};

export function getRequiredInfrastructureVersion(
  hotUpdaterVersion: string = getTargetAt({
    index: -1,
    label: "UPDATE_TARGETS",
    targets: UPDATE_TARGETS,
  }).version,
): string {
  return getRequiredUpdateTarget(hotUpdaterVersion).version;
}

export function getRequiredServerVersion(
  hotUpdaterVersion: string = getLatestKnownTargetVersion(),
): string {
  return getRequiredUpdateTarget(hotUpdaterVersion).version;
}

export function getRequiredUpdateTarget(
  hotUpdaterVersion: string = getLatestKnownTargetVersion(),
  bundledServerVersion: string = HOT_UPDATER_SERVER_VERSION,
): RequiredUpdateTarget {
  const target =
    getRequiredTarget({
      hotUpdaterVersion,
      targets: UPDATE_TARGETS,
    }) ??
    getTargetAt({
      index: -1,
      label: "UPDATE_TARGETS",
      targets: UPDATE_TARGETS,
    });
  const serverCore = coerce(bundledServerVersion);
  // A prerelease CLI must accept the runtime it ships for this generation.
  // Keep the stable baseline for upgrade history and generation validation.
  if (
    isPrerelease(hotUpdaterVersion) &&
    isPrerelease(bundledServerVersion) &&
    serverCore &&
    `${serverCore.major}.${serverCore.minor}.${serverCore.patch}` ===
      target.version
  ) {
    return { ...target, minimumPrereleaseVersion: bundledServerVersion };
  }
  return target;
}

export function isInfrastructureUpdateRequired({
  serverVersion,
  requiredVersion = getRequiredInfrastructureVersion(),
}: {
  serverVersion: string;
  requiredVersion?: string;
}): boolean {
  const normalizedServerVersion = normalize(serverVersion);
  const normalizedRequiredVersion = normalize(requiredVersion);

  if (!normalizedServerVersion || !normalizedRequiredVersion) {
    throw new Error("Invalid infrastructure version");
  }

  return isLess(normalizedServerVersion, normalizedRequiredVersion);
}

export function isV1InfrastructureRequired(requiredVersion: string): boolean {
  const normalizedRequiredVersion = normalize(requiredVersion);
  if (!normalizedRequiredVersion) {
    throw new Error("Invalid infrastructure version");
  }
  return !isLess(normalizedRequiredVersion, "1.0.0");
}
