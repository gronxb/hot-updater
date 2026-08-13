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
  catalogCacheError?: string;
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

const getCatalogCacheError = (serverBaseUrl: string): string | undefined => {
  const url = new URL(serverBaseUrl);
  if (
    url.hostname.endsWith(".supabase.co") &&
    url.pathname.startsWith("/functions/v1/")
  ) {
    return (
      "Direct Supabase Edge Function URLs do not provide the shared Release " +
      "catalog cache guarantee. Configure an external CDN endpoint."
    );
  }
  return undefined;
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
  const catalogCacheError = getCatalogCacheError(baseUrl);
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
          catalogCacheError,
          versionEndpoint,
          requiredVersion,
          needsUpdate: true,
          updateReason: "Version endpoint not found",
        };
      }

      return {
        baseUrl,
        catalogCacheError,
        versionEndpoint,
        requiredVersion,
        error: `Version endpoint returned ${response.status}`,
      };
    }

    const data = (await response.json()) as ServerVersionResponse;
    if (typeof data.version !== "string") {
      return {
        baseUrl,
        catalogCacheError,
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
      catalogCacheError,
      versionEndpoint,
      serverVersion: data.version,
      requiredVersion,
      needsUpdate,
      updateReason: needsUpdate ? requiredTarget.note : undefined,
    };
  } catch (error) {
    return {
      baseUrl,
      catalogCacheError,
      versionEndpoint,
      requiredVersion,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
