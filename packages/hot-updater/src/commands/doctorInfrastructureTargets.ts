import { coerce, isLess, isLessOrEqual, isPrerelease, normalize } from "verkit";

import { INFRASTRUCTURE_UPDATES } from "./infrastructureUpdates";

export interface UpdateTarget {
  readonly version: string;
  readonly note: string;
}

export interface RequiredUpdateTarget extends UpdateTarget {
  /**
   * A prerelease CLI of the target's own release also accepts a prerelease
   * server of it, whose schema and API are that release's.
   */
  readonly acceptsPrerelease?: boolean;
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

/** `major.minor.patch` of `version`, without its prerelease. */
const releaseOf = (version: string): string | null => {
  const core = coerce(version);
  return core ? `${core.major}.${core.minor}.${core.patch}` : null;
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
    targets.find((target) => !isPrerelease(target.version)) ??
    getTargetAt({
      index: 0,
      label: "UPDATE_TARGETS",
      targets,
    })
  );
};

export function getRequiredInfrastructureVersion(
  hotUpdaterVersion: string = getLatestKnownTargetVersion(),
): string {
  return getRequiredUpdateTarget(hotUpdaterVersion).version;
}

export function getRequiredServerVersion(
  hotUpdaterVersion: string = getLatestKnownTargetVersion(),
): string {
  return getRequiredUpdateTarget(hotUpdaterVersion).version;
}

/**
 * The newest infrastructure update `hotUpdaterVersion` reaches: the release
 * whose server schema and API this CLI needs. It is never the CLI's own
 * version, so a release that changes only the CLI asks for no redeploy.
 */
export function getRequiredUpdateTarget(
  hotUpdaterVersion: string = getLatestKnownTargetVersion(),
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
  // A stable CLI keeps the stable baseline: a prerelease server of its
  // target may predate the release's final schema.
  return {
    ...target,
    acceptsPrerelease:
      isPrerelease(hotUpdaterVersion) &&
      releaseOf(hotUpdaterVersion) === target.version,
  };
}

export function isInfrastructureUpdateRequired({
  serverVersion,
  requiredVersion = getRequiredInfrastructureVersion(),
  acceptsPrerelease = false,
}: {
  serverVersion: string;
  requiredVersion?: string;
  /** Compare only the server's `major.minor.patch`. */
  acceptsPrerelease?: boolean;
}): boolean {
  const normalizedServerVersion = normalize(
    acceptsPrerelease ? (releaseOf(serverVersion) ?? "") : serverVersion,
  );
  const normalizedRequiredVersion = normalize(requiredVersion);

  if (!normalizedServerVersion || !normalizedRequiredVersion) {
    throw new Error("Invalid infrastructure version");
  }

  return isLess(normalizedServerVersion, normalizedRequiredVersion);
}
