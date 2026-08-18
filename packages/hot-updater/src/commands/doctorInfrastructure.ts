import {
  getRequiredUpdateTarget,
  isInfrastructureUpdateRequired,
  isV1InfrastructureRequired,
  type RequiredUpdateTarget,
} from "./doctorInfrastructureTargets";

export {
  getRequiredInfrastructureVersion,
  getRequiredServerVersion,
  getRequiredUpdateTarget,
  isInfrastructureUpdateRequired,
  isV1InfrastructureRequired,
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
  fixability: "blocked";
  reason: string;
  commands: string[];
}

const INFRASTRUCTURE_RECOVERY_COMMANDS = [
  "hot-updater init",
  "hot-updater db migrate",
  "hot-updater db generate",
] as const;

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

export const createInfrastructureRemediation = ({
  upgradeBlocked = false,
}: {
  upgradeBlocked?: boolean;
} = {}): InfrastructureRemediation => {
  if (upgradeBlocked) {
    return {
      fixability: "blocked",
      reason:
        "Hot Updater v0 infrastructure cannot be upgraded in place. Run init with new provider resources and ship the new endpoint in a new native build. Existing resources are left unchanged.",
      commands: ["hot-updater init"],
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
  const catalogMode = getCatalogMode(baseUrl);
  const requiredVersion = requiredTarget.version;
  const requiresV1 = isV1InfrastructureRequired(requiredVersion);

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
          ...(requiresV1
            ? {
                upgradeBlocked: true,
                updateReason:
                  "v1 infrastructure marker not found at the existing endpoint",
              }
            : {
                needsUpdate: true,
                updateReason: "Version endpoint not found",
              }),
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

    if (requiresV1 && data.infrastructureGeneration !== 1) {
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

    if (
      data.infrastructureGeneration !== undefined &&
      data.infrastructureGeneration !== 1
    ) {
      return {
        baseUrl,
        ...catalogMode,
        versionEndpoint,
        serverVersion: data.version,
        requiredVersion,
        error: `Unsupported infrastructure generation: ${String(data.infrastructureGeneration)}`,
      };
    }

    const needsUpdate = isInfrastructureUpdateRequired({
      serverVersion: data.version,
      ...(data.infrastructureGeneration === 1
        ? { infrastructureGeneration: 1 }
        : {}),
      requiredVersion,
    });

    return {
      baseUrl,
      ...catalogMode,
      versionEndpoint,
      serverVersion: data.version,
      ...(data.infrastructureGeneration === 1
        ? { infrastructureGeneration: 1 }
        : {}),
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
