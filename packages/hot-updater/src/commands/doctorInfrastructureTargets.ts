import * as semver from "semver";

export type InfrastructureRequirement = "infrastructure" | "server";

interface InfrastructureUpdateTarget {
  version: string;
  note: string;
}

export interface RequiredUpdateTarget {
  version: string;
  kind: InfrastructureRequirement;
  note: string;
}

export const INFRASTRUCTURE_UPDATE_TARGETS = [
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
] as const satisfies readonly [
  InfrastructureUpdateTarget,
  ...InfrastructureUpdateTarget[],
];

export const SERVER_UPDATE_TARGETS = [
  {
    version: "0.32.1",
    note: "provider update checks reuse selected bundles",
  },
] as const satisfies readonly [
  InfrastructureUpdateTarget,
  ...InfrastructureUpdateTarget[],
];

const getTargetVersionAt = ({
  index,
  label,
  targets,
}: {
  index: number;
  label: string;
  targets: readonly InfrastructureUpdateTarget[];
}): string => {
  const target = targets.at(index);
  if (!target) {
    throw new Error(`${label} must not be empty`);
  }
  return target.version;
};

const getLatestKnownTargetVersion = () => {
  const infrastructureVersion = getTargetVersionAt({
    index: -1,
    label: "INFRASTRUCTURE_UPDATE_TARGETS",
    targets: INFRASTRUCTURE_UPDATE_TARGETS,
  });
  const serverVersion = getTargetVersionAt({
    index: -1,
    label: "SERVER_UPDATE_TARGETS",
    targets: SERVER_UPDATE_TARGETS,
  });

  return semver.gte(serverVersion, infrastructureVersion)
    ? serverVersion
    : infrastructureVersion;
};

const getRequiredTarget = ({
  fallbackVersion,
  hotUpdaterVersion,
  targets,
}: {
  fallbackVersion: string;
  hotUpdaterVersion: string;
  targets: readonly InfrastructureUpdateTarget[];
}) => {
  const current = semver.coerce(hotUpdaterVersion)?.version;

  if (!current) {
    return null;
  }

  let requiredTarget: InfrastructureUpdateTarget | null = null;

  for (const target of targets) {
    if (semver.lte(target.version, current)) {
      requiredTarget = target;
    }
  }

  return requiredTarget ?? { version: fallbackVersion, note: "" };
};

const getRequiredInfrastructureTarget = (
  hotUpdaterVersion: string,
): InfrastructureUpdateTarget => {
  const fallbackVersion = getTargetVersionAt({
    index: 0,
    label: "INFRASTRUCTURE_UPDATE_TARGETS",
    targets: INFRASTRUCTURE_UPDATE_TARGETS,
  });

  return (
    getRequiredTarget({
      fallbackVersion,
      hotUpdaterVersion,
      targets: INFRASTRUCTURE_UPDATE_TARGETS,
    }) ?? {
      version: getTargetVersionAt({
        index: -1,
        label: "INFRASTRUCTURE_UPDATE_TARGETS",
        targets: INFRASTRUCTURE_UPDATE_TARGETS,
      }),
      note: "",
    }
  );
};

const getRequiredServerTarget = (
  hotUpdaterVersion: string,
): InfrastructureUpdateTarget | null =>
  getRequiredTarget({
    fallbackVersion: getRequiredInfrastructureVersion(hotUpdaterVersion),
    hotUpdaterVersion,
    targets: SERVER_UPDATE_TARGETS,
  });

export function getRequiredInfrastructureVersion(
  hotUpdaterVersion: string = getTargetVersionAt({
    index: -1,
    label: "INFRASTRUCTURE_UPDATE_TARGETS",
    targets: INFRASTRUCTURE_UPDATE_TARGETS,
  }),
): string {
  return getRequiredInfrastructureTarget(hotUpdaterVersion).version;
}

export function getRequiredServerVersion(
  hotUpdaterVersion: string = getLatestKnownTargetVersion(),
): string {
  return getRequiredUpdateTarget(hotUpdaterVersion).version;
}

export function getRequiredUpdateTarget(
  hotUpdaterVersion: string = getLatestKnownTargetVersion(),
): RequiredUpdateTarget {
  const infrastructureTarget =
    getRequiredInfrastructureTarget(hotUpdaterVersion);
  const serverTarget = getRequiredServerTarget(hotUpdaterVersion);

  if (
    serverTarget &&
    semver.gt(serverTarget.version, infrastructureTarget.version)
  ) {
    return {
      version: serverTarget.version,
      kind: "server",
      note: serverTarget.note,
    };
  }

  return {
    version: infrastructureTarget.version,
    kind: "infrastructure",
    note: infrastructureTarget.note,
  };
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
