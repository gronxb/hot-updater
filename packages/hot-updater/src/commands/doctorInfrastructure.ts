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
  requiredVersion: string;
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

export const createInfrastructureRemediation =
  (): InfrastructureRemediation => {
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
          needsUpdate: true,
          updateReason: "Version endpoint not found",
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

    const needsUpdate = isInfrastructureUpdateRequired({
      serverVersion: data.version,
      requiredVersion,
    });

    return {
      baseUrl,
      ...catalogMode,
      versionEndpoint,
      serverVersion: data.version,
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
