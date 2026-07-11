import type { AppUpdateInfo } from "@hot-updater/core";

import { fetchUpdateInfo } from "./fetchUpdateInfo";
import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";
import type {
  HotUpdaterBaseURL,
  HotUpdaterResolver,
  ResolverCheckUpdateParams,
  ResolverNotifyAppReadyParams,
} from "./types";

const resolveBaseURL = async (baseURL: HotUpdaterBaseURL): Promise<string> => {
  const resolvedBaseURL =
    typeof baseURL === "function" ? await baseURL() : baseURL;

  if (!resolvedBaseURL) {
    throw new Error("baseURL resolver must return a non-empty string");
  }

  return resolvedBaseURL;
};

type RuntimeCrypto = {
  readonly getRandomValues?: (values: Uint8Array) => Uint8Array;
};

const createEventId = (): string => {
  const randomBytes = new Uint8Array(10);
  const runtimeCrypto = (globalThis as { readonly crypto?: RuntimeCrypto })
    .crypto;
  if (runtimeCrypto?.getRandomValues) {
    runtimeCrypto.getRandomValues(randomBytes);
  } else {
    for (let index = 0; index < randomBytes.length; index += 1) {
      randomBytes[index] = Math.floor(Math.random() * 256);
    }
  }

  const randomHex = Array.from(randomBytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const timestampHex = Date.now().toString(16).padStart(12, "0");
  const randA = randomHex.slice(0, 3);
  const randB = randomHex.slice(3, 19);
  const variantByte = (0x80 | (Number.parseInt(randB.slice(0, 2), 16) & 0x3f))
    .toString(16)
    .padStart(2, "0");

  return [
    timestampHex.slice(0, 8),
    timestampHex.slice(8),
    `7${randA}`,
    `${variantByte}${randB.slice(2, 4)}`,
    randB.slice(4, 16),
  ].join("-");
};

/**
 * Creates a default resolver that uses baseURL for network operations.
 * This encapsulates the existing baseURL logic into a resolver.
 *
 * @param baseURL - The base URL for the update server, or a function that
 * resolves it before each update check.
 * @returns A HotUpdaterResolver that uses the baseURL
 */
export function createDefaultResolver(
  baseURL: HotUpdaterBaseURL,
): HotUpdaterResolver {
  return {
    checkUpdate: async (
      params: ResolverCheckUpdateParams,
    ): Promise<AppUpdateInfo | null> => {
      const resolvedBaseURL = (await resolveBaseURL(baseURL)).replace(
        /\/+$/,
        "",
      );
      let url: string;
      const cohortPath = `/${encodeURIComponent(params.cohort)}`;

      if (params.updateStrategy === "fingerprint") {
        if (!params.fingerprintHash) {
          throw new Error("Fingerprint hash is required");
        }
        url = `${resolvedBaseURL}/fingerprint/${params.platform}/${params.fingerprintHash}/${params.channel}/${params.minBundleId}/${params.bundleId}${cohortPath}`;
      } else {
        url = `${resolvedBaseURL}/app-version/${params.platform}/${params.appVersion}/${params.channel}/${params.minBundleId}/${params.bundleId}${cohortPath}`;
      }

      return fetchUpdateInfo({
        url,
        requestHeaders: {
          ...params.requestHeaders,
          "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
        },
        requestTimeout: params.requestTimeout,
      });
    },
    notifyAppReady: async (
      params: ResolverNotifyAppReadyParams,
    ): Promise<{
      status: "RECOVERED" | "STABLE";
      crashedBundleId?: string;
    }> => {
      const resolvedBaseURL = (await resolveBaseURL(baseURL)).replace(
        /\/+$/,
        "",
      );
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, params.requestTimeout ?? 5000);
      const eventId = createEventId();

      try {
        const response = await fetch(
          `${resolvedBaseURL}/bundle-events/app-ready`,
          {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              ...params.requestHeaders,
              "Hot-Updater-Event-ID": eventId,
              "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
            },
            body: JSON.stringify({
              activeBundleId: params.activeBundleId,
              previousActiveBundleId: params.previousActiveBundleId,
              crashedBundleId: params.crashedBundleId,
              platform: params.platform,
              channel: params.channel,
              appVersion: params.appVersion,
              fingerprintHash: params.fingerprintHash,
              cohort: params.cohort,
              installId: params.installId,
              userId: params.userId,
              sdkVersion: params.sdkVersion,
              defaultChannel: params.defaultChannel,
              isChannelSwitched: params.isChannelSwitched,
              status: params.status,
            }),
          },
        );

        if (response.status === 404 || response.status === 501) {
          return {
            status: params.status,
            ...(params.crashedBundleId
              ? { crashedBundleId: params.crashedBundleId }
              : {}),
          };
        }

        if (response.status < 200 || response.status >= 300) {
          throw new Error(response.statusText);
        }

        return {
          status: params.status,
          ...(params.crashedBundleId
            ? { crashedBundleId: params.crashedBundleId }
            : {}),
        };
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Request timed out");
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}
