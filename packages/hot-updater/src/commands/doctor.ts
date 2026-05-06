import { getCwd, p } from "@hot-updater/cli-tools";
import { merge } from "es-toolkit";
import { readPackageUp } from "read-package-up";
import * as semver from "semver";

import { ui } from "../utils/cli-ui";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface VersionMismatch {
  packageName: string;
  currentVersion: string;
  expectedVersion: string;
}

interface InfrastructureStatus {
  baseUrl: string;
  versionEndpoint: string;
  serverVersion?: string;
  requiredVersion: string;
  needsUpdate?: boolean;
  updateReason?: string;
  error?: string;
}

interface DoctorDetails {
  // Version related
  hotUpdaterVersion?: string;
  versionMismatches?: VersionMismatch[];
  infrastructure?: InfrastructureStatus;

  // Package info
  packageJsonPath?: string;
  installedHotUpdaterPackages?: string[];

  // Future extensibility - can add more checks here
  // e.g., configurationIssues?: ConfigIssue[];
  // e.g., compatibilityWarnings?: Warning[];
}

interface DoctorResult {
  success: boolean;
  error?: string;
  details?: DoctorDetails;
}

interface DoctorOptions {
  cwd?: string;
  serverBaseUrl?: string;
  fetch?: typeof fetch;
}

interface ServerVersionResponse {
  version?: unknown;
}

interface InfrastructureUpdateTarget {
  version: string;
  note: string;
}

// Only versions that require deployed server/infrastructure changes belong here.
// Regular package releases must not be added unless existing infrastructure needs
// to be redeployed or migrated for compatibility.
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
] as const satisfies readonly [
  InfrastructureUpdateTarget,
  ...InfrastructureUpdateTarget[],
];

const getInfrastructureTargetVersionAt = (index: number): string => {
  const target = INFRASTRUCTURE_UPDATE_TARGETS.at(index);
  if (!target) {
    throw new Error("INFRASTRUCTURE_UPDATE_TARGETS must not be empty");
  }
  return target.version;
};

/**
 * Checks if two versions (or version and range) are compatible.
 * @param versionA - First version or range string.
 * @param versionB - Second version or range string.
 * @returns True if compatible, false otherwise.
 */
export function areVersionsCompatible(
  versionA: string,
  versionB: string,
): boolean {
  if (versionA === versionB) {
    return true;
  }

  const options = { includePrerelease: true };

  // Check if versionA satisfies versionB (when versionB is a range)
  if (
    semver.valid(versionA) &&
    semver.validRange(versionB) &&
    semver.satisfies(versionA, versionB, options)
  ) {
    return true;
  }

  // Check if versionB satisfies versionA (when versionA is a range)
  if (
    semver.valid(versionB) &&
    semver.validRange(versionA) &&
    semver.satisfies(versionB, versionA, options)
  ) {
    return true;
  }

  return false;
}

export function getRequiredInfrastructureVersion(
  hotUpdaterVersion: string = getInfrastructureTargetVersionAt(-1),
): string {
  const current = semver.coerce(hotUpdaterVersion)?.version;

  if (!current) {
    return getInfrastructureTargetVersionAt(-1);
  }

  let requiredVersion = getInfrastructureTargetVersionAt(0);

  for (const target of INFRASTRUCTURE_UPDATE_TARGETS) {
    if (semver.lte(target.version, current)) {
      requiredVersion = target.version;
    }
  }

  return requiredVersion;
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

export function resolveVersionEndpoint(serverBaseUrl: string): string {
  const url = new URL(serverBaseUrl.trim());
  const pathname = url.pathname.replace(/\/+$/, "");

  url.hash = "";
  url.search = "";
  url.pathname = `${pathname}/version`;
  return url.toString();
}

async function checkInfrastructureStatus({
  serverBaseUrl,
  fetchImpl = fetch,
  requiredVersion = getRequiredInfrastructureVersion(),
}: {
  serverBaseUrl: string;
  fetchImpl?: typeof fetch;
  requiredVersion?: string;
}): Promise<InfrastructureStatus> {
  const versionEndpoint = resolveVersionEndpoint(serverBaseUrl);
  const baseUrl = serverBaseUrl.trim();

  try {
    const response = await fetchImpl(versionEndpoint, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return {
          baseUrl,
          versionEndpoint,
          requiredVersion,
          needsUpdate: true,
          updateReason: "Version endpoint not found",
        };
      }

      return {
        baseUrl,
        versionEndpoint,
        requiredVersion,
        error: `Version endpoint returned ${response.status}`,
      };
    }

    const data = (await response.json()) as ServerVersionResponse;
    if (typeof data.version !== "string") {
      return {
        baseUrl,
        versionEndpoint,
        requiredVersion,
        error: "Version endpoint response must include a string version",
      };
    }

    const needsUpdate = isInfrastructureUpdateRequired({
      serverVersion: data.version,
      requiredVersion,
    });

    return {
      baseUrl,
      versionEndpoint,
      serverVersion: data.version,
      requiredVersion,
      needsUpdate,
    };
  } catch (error) {
    return {
      baseUrl,
      versionEndpoint,
      requiredVersion,
      error: (error as Error).message,
    };
  }
}

/**
 * Performs health check on Hot Updater installation
 * @param options - Doctor check options
 * @returns true if everything is healthy, or DoctorResult with details if there are issues
 */
export async function doctor(
  options: DoctorOptions = {},
): Promise<true | DoctorResult> {
  try {
    const { cwd = getCwd(), serverBaseUrl, fetch: fetchImpl } = options;

    // Read package.json
    const packageResult = await readPackageUp({ cwd });

    if (!packageResult) {
      return {
        success: false,
        error: "Could not find package.json",
      };
    }

    const packageJson = packageResult.packageJson as PackageJson;
    const packageJsonPath = packageResult.path;

    // Merge all dependencies
    const allDependencies = merge(
      packageJson.dependencies ?? {},
      packageJson.devDependencies ?? {},
    );

    // Check hot-updater version
    const hotUpdaterVersion = allDependencies["hot-updater"];

    if (!hotUpdaterVersion) {
      return {
        success: false,
        error: "hot-updater CLI not found. Please install it first.",
      };
    }

    // Find all @hot-updater packages
    const hotUpdaterPackages = Object.keys(allDependencies).filter((key) =>
      key.startsWith("@hot-updater/"),
    );

    // Check for version mismatches
    const versionMismatches: VersionMismatch[] = [];

    for (const packageName of hotUpdaterPackages) {
      const currentVersion = allDependencies[packageName];
      if (
        hotUpdaterVersion &&
        currentVersion &&
        !areVersionsCompatible(currentVersion, hotUpdaterVersion)
      ) {
        versionMismatches.push({
          packageName,
          currentVersion,
          expectedVersion: hotUpdaterVersion,
        });
      }
    }

    // Build details object
    const details: DoctorDetails = {
      hotUpdaterVersion,
      packageJsonPath,
      installedHotUpdaterPackages: hotUpdaterPackages,
    };

    if (serverBaseUrl) {
      details.infrastructure = await checkInfrastructureStatus({
        serverBaseUrl,
        fetchImpl,
        requiredVersion: getRequiredInfrastructureVersion(hotUpdaterVersion),
      });
    }

    // Add version mismatches if any
    if (versionMismatches.length > 0) {
      details.versionMismatches = versionMismatches;
    }

    // Check if there are any issues
    const hasInfrastructureIssue =
      details.infrastructure?.error !== undefined ||
      details.infrastructure?.needsUpdate === true;
    const hasIssues = versionMismatches.length > 0 || hasInfrastructureIssue;
    // Future: || configurationIssues.length > 0 || etc.

    if (hasIssues) {
      return {
        success: false,
        details,
      };
    }

    if (details.infrastructure) {
      return {
        success: true,
        details,
      };
    }

    // Everything is healthy
    return true;
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

const promptServerBaseUrl = async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  const serverBaseUrl = await p.text({
    message: "Server base URL for infrastructure check (Enter to skip)",
    placeholder: "https://example.com/api/check-update",
    validate(value) {
      const trimmed = value?.trim() ?? "";
      if (!trimmed) return;

      try {
        new URL(trimmed);
      } catch {
        return "Enter a valid URL";
      }

      return;
    },
  });

  if (p.isCancel(serverBaseUrl)) {
    p.cancel("Doctor check cancelled");
    process.exit(0);
  }

  const trimmed = serverBaseUrl.trim();
  return trimmed ? trimmed : undefined;
};

export const handleDoctor = async ({
  serverBaseUrl,
}: {
  serverBaseUrl?: string;
} = {}) => {
  p.intro("Hot Updater doctor");

  const resolvedServerBaseUrl = serverBaseUrl ?? (await promptServerBaseUrl());
  const result = await doctor({ serverBaseUrl: resolvedServerBaseUrl });

  if (result === true) {
    p.log.success("All checks passed.");
    p.outro("Healthy.");
    return;
  }

  // Handle errors
  if (result.error) {
    p.log.error(result.error);
    p.outro("Doctor check failed.");
    return;
  }

  // Handle issues with details
  const { details } = result;
  let shouldExitWithFailure = !result.success;

  if (details?.hotUpdaterVersion) {
    p.log.message(
      ui.block("Version", [
        ui.kv("CLI", ui.version(details.hotUpdaterVersion)),
      ]),
    );
  }

  if (details?.infrastructure) {
    const infrastructure = details.infrastructure;
    const lines = [ui.kv("Endpoint", ui.path(infrastructure.versionEndpoint))];

    if (infrastructure.serverVersion) {
      lines.push(ui.kv("Server", ui.version(infrastructure.serverVersion)));
      lines.push(ui.kv("Required", ui.version(infrastructure.requiredVersion)));
    }
    p.log.message(ui.block("Infrastructure", lines));

    if (infrastructure.needsUpdate) {
      p.log.error(
        `Infrastructure update required: ${infrastructure.requiredVersion}+`,
      );
      if (infrastructure.updateReason) {
        p.log.info(`Reason: ${infrastructure.updateReason}`);
      }
    } else if (infrastructure.error) {
      p.log.error(`Infrastructure check failed: ${infrastructure.error}`);
    } else {
      p.log.success("Infrastructure is up to date.");
    }
  }

  if (details?.versionMismatches && details.versionMismatches.length > 0) {
    p.log.warn("Version mismatches found:");

    for (const mismatch of details.versionMismatches) {
      p.log.error(
        `${mismatch.packageName}: ${mismatch.currentVersion} ` +
          `(expected ${mismatch.expectedVersion})`,
      );
    }
  }

  if (shouldExitWithFailure) {
    process.exit(1);
  }

  p.log.success("All checks passed.");
  p.outro("Doctor complete.");
};
