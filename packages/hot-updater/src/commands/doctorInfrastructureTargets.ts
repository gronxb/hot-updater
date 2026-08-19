import { coerce, isLess, isLessOrEqual, normalize } from "verkit";

export interface UpdateTarget {
  readonly version: string;
  readonly note: string;
}

export type RequiredUpdateTarget = UpdateTarget;

export const UPDATE_TARGETS = [
  {
    version: "1.0.0",
    note: "Release Catalog infrastructure generation",
  },
] as const satisfies readonly [UpdateTarget, ...UpdateTarget[]];

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
): RequiredUpdateTarget {
  return (
    getRequiredTarget({
      hotUpdaterVersion,
      targets: UPDATE_TARGETS,
    }) ??
    getTargetAt({
      index: -1,
      label: "UPDATE_TARGETS",
      targets: UPDATE_TARGETS,
    })
  );
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
