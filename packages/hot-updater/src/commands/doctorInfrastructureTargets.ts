import * as semver from "semver";

export interface UpdateTarget {
  readonly version: string;
  readonly note: string;
}

export type RequiredUpdateTarget = UpdateTarget;

export const UPDATE_TARGETS = [
  {
    version: "0.13.0",
    note: "Initial provider infrastructure migrations",
  },
  {
    version: "0.18.0",
    note: "Provider infrastructure migration",
  },
  {
    version: "0.21.0",
    note: "ORM schema version target",
  },
  {
    version: "0.29.0",
    note: "Rollout infrastructure fields",
  },
  {
    version: "0.30.0",
    note: "Target cohort rollout behavior",
  },
  {
    version: "0.31.0",
    note: "Bundle artifact storage fields",
  },
  {
    version: "0.32.0",
    note: "Content-addressed manifest asset routing",
  },
  {
    version: "0.33.0",
    note: "provider update checks reuse selected bundles",
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
  const current = semver.coerce(hotUpdaterVersion)?.version;

  if (!current) {
    return null;
  }

  let requiredTarget: UpdateTarget | null = null;

  for (const target of targets) {
    if (semver.lte(target.version, current)) {
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
  const normalizedServerVersion = semver.valid(serverVersion);
  const normalizedRequiredVersion = semver.valid(requiredVersion);

  if (!normalizedServerVersion || !normalizedRequiredVersion) {
    throw new Error("Invalid infrastructure version");
  }

  return semver.lt(normalizedServerVersion, normalizedRequiredVersion);
}
