import {
  foreignPluginsNote,
  type ManagedDeployment,
  replaySourceNote,
} from "./doctor/managed";
import {
  type ScaffoldUpgrade,
  scaffoldUpgradeNote,
} from "./doctor/scaffoldRecords";
import {
  getRequiredUpdateTarget,
  isInfrastructureUpdateRequired,
  type RequiredUpdateTarget,
} from "./doctorInfrastructureTargets";

export {
  getRequiredInfrastructureVersion,
  getRequiredServerVersion,
  getRequiredUpdateTarget,
  isInfrastructureUpdateRequired,
} from "./doctorInfrastructureTargets";

export interface InfrastructureStatus {
  baseUrl: string;
  catalogMode?: "origin-only";
  catalogModeNote?: string;
  versionEndpoint: string;
  serverVersion?: string;
  infrastructureGeneration?: number;
  requiredVersion: string;
  needsUpdate?: boolean;
  upgradeBlocked?: boolean;
  updateReason?: string;
  error?: string;
  remediation?: InfrastructureRemediation;
}

interface ServerVersionResponse {
  infrastructureGeneration?: unknown;
  version?: unknown;
}

export interface InfrastructureRemediation {
  reason: string;
  commands: string[];
}

export function resolveVersionEndpoint(serverBaseUrl: string): string {
  const url = new URL(serverBaseUrl.trim());
  const pathname = url.pathname.replace(/\/+$/, "");

  url.hash = "";
  url.search = "";
  url.pathname = `${pathname}/version`;
  return url.toString();
}

const getCatalogMode = (
  serverBaseUrl: string,
): Pick<InfrastructureStatus, "catalogMode" | "catalogModeNote"> => {
  const url = new URL(serverBaseUrl);
  if (
    url.hostname.endsWith(".supabase.co") &&
    url.pathname.startsWith("/functions/v1/")
  ) {
    return {
      catalogMode: "origin-only",
      catalogModeNote:
        "Each catalog check still invokes the Supabase Edge Function; " +
        "compiled catalogs avoid per-install decision queries.",
    };
  }
  return {};
};

/** What deploys a server of this release, beside migrating its database. */
export type ServerDeployment = Pick<
  ManagedDeployment,
  "command" | "server" | "confirmed" | "foreignPlugins" | "source"
>;

export const createInfrastructureRemediation = ({
  upgradeBlocked = false,
  requiredVersion,
  managed = null,
  schemaBlockers = [],
  scaffold = null,
}: {
  upgradeBlocked?: boolean;
  requiredVersion?: string;
  /** The deployment `hot-updater init` manages; null for a server of the project's own. */
  managed?: ServerDeployment | null;
  /**
   * The schema issues that block a migration, such as SCHEMA_NEWER_THAN_CLI:
   * an upgrade would write this release's settings over them.
   */
  schemaBlockers?: readonly string[];
  /** The agent infrastructure scaffold that keeps the deployment, which takes init's place. */
  scaffold?: ScaffoldUpgrade | null;
} = {}): InfrastructureRemediation => {
  if (upgradeBlocked) {
    return {
      reason:
        "Hot Updater v0 infrastructure cannot be upgraded in place. Generate a parallel v1 setup with hot-updater agent infra setup, or use init interactively, and ship the new endpoint in a new native build.",
      commands: ["hot-updater agent infra setup", "hot-updater init"],
    };
  }
  if (schemaBlockers.length > 0) {
    return {
      reason: `Resolve ${schemaBlockers.join(", ")} first, as the schema check says: upgrading the server migrates its database, which would write this release's settings over the ones doctor reports.`,
      commands: [],
    };
  }
  if (scaffold !== null) {
    return {
      reason: `${scaffoldUpgradeNote(scaffold)} A server of an earlier release answers 503 once the database is migrated.`,
      commands: scaffold.command === null ? [] : [scaffold.command],
    };
  }
  const target =
    requiredVersion === undefined ? "of this release" : `${requiredVersion}+`;
  const own = {
    reason: `Deploy the server from @hot-updater/server ${target} and migrate its database as it deploys: npx hot-updater db migrate <server file> in the server's project, or, for Drizzle, Prisma, D1 and Supabase, npx hot-updater db generate <server file> and the database's tooling first. A server of an earlier release answers 503 once the database is migrated. A deployment from hot-updater agent infra gets versioned upgrade instructions from hot-updater agent infra upgrade.`,
    commands: [
      "npx hot-updater db migrate <server file>",
      "npx hot-updater db generate <server file>",
      "npx hot-updater agent infra upgrade",
    ],
  };
  if (managed === null) return own;
  const foreign = foreignPluginsNote(managed);
  if (foreign !== undefined) {
    return { reason: `${foreign} ${own.reason}`, commands: own.commands };
  }
  const replay = `Run ${managed.command}: it applies the database migrations of this release and redeploys ${managed.server} from it in one run, so the 503 window is the deploy. A server of an earlier release answers 503 once the database is migrated, so run nothing in between.${replaySourceNote(managed)}`;
  return managed.confirmed
    ? { reason: replay, commands: [managed.command] }
    : {
        reason: `If hot-updater.config.ts names the database hot-updater init saved in .env.hotupdater: ${replay} Otherwise: ${own.reason}`,
        commands: [managed.command, ...own.commands],
      };
};

export async function checkInfrastructureStatus({
  serverBaseUrl,
  fetchImpl = fetch,
  requiredTarget = getRequiredUpdateTarget(),
}: {
  serverBaseUrl: string;
  fetchImpl?: typeof fetch;
  requiredTarget?: RequiredUpdateTarget;
}): Promise<InfrastructureStatus> {
  const versionEndpoint = resolveVersionEndpoint(serverBaseUrl);
  const baseUrl = serverBaseUrl.trim();
  const catalogMode = getCatalogMode(baseUrl);
  const requiredVersion =
    requiredTarget.minimumPrereleaseVersion ?? requiredTarget.version;

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
          ...catalogMode,
          versionEndpoint,
          requiredVersion,
          upgradeBlocked: true,
          updateReason:
            "v1 infrastructure marker not found at the existing endpoint",
        };
      }

      return {
        baseUrl,
        ...catalogMode,
        versionEndpoint,
        requiredVersion,
        error: `Version endpoint returned ${response.status}`,
      };
    }

    const data = (await response.json()) as ServerVersionResponse;
    if (typeof data.version !== "string") {
      return {
        baseUrl,
        ...catalogMode,
        versionEndpoint,
        requiredVersion,
        error: "Version endpoint response must include a string version",
      };
    }

    if (data.infrastructureGeneration !== 1) {
      return {
        baseUrl,
        ...catalogMode,
        versionEndpoint,
        serverVersion: data.version,
        requiredVersion,
        upgradeBlocked: true,
        updateReason: "Existing infrastructure does not declare generation 1",
      };
    }

    const needsUpdate = isInfrastructureUpdateRequired({
      serverVersion: data.version,
      requiredVersion,
    });

    return {
      baseUrl,
      ...catalogMode,
      versionEndpoint,
      serverVersion: data.version,
      infrastructureGeneration: 1,
      requiredVersion,
      needsUpdate,
      updateReason: needsUpdate ? requiredTarget.note : undefined,
    };
  } catch (error) {
    return {
      baseUrl,
      ...catalogMode,
      versionEndpoint,
      requiredVersion,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
