import { fetchUpdateInfo } from "./fetchUpdateInfo";
import type {
  HotUpdaterResolver,
  IncrementalCheckResponse,
  ResolverCheckUpdateParams,
  ResolverCheckUpdateResult,
} from "./types";

function buildCheckPath(
  params: ResolverCheckUpdateParams,
  incremental: boolean,
): string {
  const root = incremental ? "incremental" : "";

  if (params.updateStrategy === "fingerprint") {
    if (!params.fingerprintHash) {
      throw new Error("Fingerprint hash is required");
    }
    return `${root ? `/${root}` : ""}/fingerprint/${params.platform}/${params.fingerprintHash}/${params.channel}/${params.minBundleId}/${params.bundleId}`;
  }

  return `${root ? `/${root}` : ""}/app-version/${params.platform}/${params.appVersion}/${params.channel}/${params.minBundleId}/${params.bundleId}`;
}

async function fetchIncrementalInfo({
  url,
  requestHeaders,
  requestTimeout = 5000,
}: {
  url: string;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
}): Promise<IncrementalCheckResponse | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, requestTimeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal as any,
      headers: {
        "Content-Type": "application/json",
        ...requestHeaders,
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as unknown;
    if (!data || typeof data !== "object" || !("mode" in data)) {
      return null;
    }

    return data as IncrementalCheckResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Creates a default resolver that uses baseURL for network operations.
 * This encapsulates the existing baseURL logic into a resolver.
 *
 * @param baseURL - The base URL for the update server
 * @returns A HotUpdaterResolver that uses the baseURL
 */
export function createDefaultResolver(baseURL: string): HotUpdaterResolver {
  return {
    checkUpdate: async (
      params: ResolverCheckUpdateParams,
    ): Promise<ResolverCheckUpdateResult | null> => {
      if (params.incremental) {
        const incrementalPath = buildCheckPath(params, true);
        const incrementalResponse = await fetchIncrementalInfo({
          url: `${baseURL}${incrementalPath}`,
          requestHeaders: params.requestHeaders,
          requestTimeout: params.requestTimeout,
        });

        if (incrementalResponse) {
          if (incrementalResponse.mode === "none") {
            return null;
          }

          if (incrementalResponse.mode === "full") {
            return incrementalResponse.full;
          }

          if (incrementalResponse.mode === "incremental") {
            return incrementalResponse;
          }
        }
      }

      const fullPath = buildCheckPath(params, false);
      return fetchUpdateInfo({
        url: `${baseURL}${fullPath}`,
        requestHeaders: params.requestHeaders,
        requestTimeout: params.requestTimeout,
      });
    },
  };
}
