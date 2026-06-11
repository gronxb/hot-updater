import {
  getRequiredUpdateTarget,
  isInfrastructureUpdateRequired,
  type InfrastructureRequirement,
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
  versionEndpoint: string;
  serverVersion?: string;
  requiredVersion: string;
  requirement?: InfrastructureRequirement;
  needsUpdate?: boolean;
  updateReason?: string;
  error?: string;
  remediation?: InfrastructureRemediation;
}

interface ServerVersionResponse {
  version?: unknown;
}

export interface InfrastructureRemediation {
  fixability: "blocked";
  reason: string;
  commands: string[];
}

const INFRASTRUCTURE_RECOVERY_COMMANDS = [
  "hot-updater init",
  "hot-updater db migrate",
  "hot-updater db generate",
] as const;

const SERVER_RECOVERY_COMMANDS = ["redeploy update-check server"] as const;

export function resolveVersionEndpoint(serverBaseUrl: string): string {
  const url = new URL(serverBaseUrl.trim());
  const pathname = url.pathname.replace(/\/+$/, "");

  url.hash = "";
  url.search = "";
  url.pathname = `${pathname}/version`;
  return url.toString();
}

export const createInfrastructureRemediation = (
  requirement: InfrastructureRequirement = "infrastructure",
): InfrastructureRemediation => {
  if (requirement === "server") {
    return {
      fixability: "blocked",
      reason:
        "Server runtime changes need provider credentials, environment variables, and redeploy access.",
      commands: [...SERVER_RECOVERY_COMMANDS],
    };
  }

  return {
    fixability: "blocked",
    reason:
      "Server infrastructure changes usually need provider credentials, environment variables, and redeploy access.",
    commands: [...INFRASTRUCTURE_RECOVERY_COMMANDS],
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
  const requiredVersion = requiredTarget.version;

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
          requirement: "infrastructure",
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
      requirement: needsUpdate ? requiredTarget.kind : undefined,
      needsUpdate,
      updateReason:
        needsUpdate && requiredTarget.kind === "server"
          ? `Server redeploy required: ${requiredTarget.note}`
          : undefined,
    };
  } catch (error) {
    return {
      baseUrl,
      versionEndpoint,
      requiredVersion,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
