import {
  isUUIDv7,
  MAX_COMPILED_CATALOG_BYTES,
  MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE,
  MAX_TARGET_COHORTS_PER_RELEASE,
  NUMERIC_COHORT_SIZE,
  type ReleaseCatalog,
  type ReleaseCatalogDescriptor,
} from "@hot-updater/core";

import { LynxUpdaterError } from "./native";
import type { ArchiveArtifact, HotUpdaterOptions, NativeState } from "./types";

const MAX_RESPONSE_BYTES = MAX_COMPILED_CATALOG_BYTES * 2 + 4096;

const invalidResponse = (message: string): never => {
  throw new LynxUpdaterError("INVALID_RESPONSE", message);
};

function descriptor(value: unknown): value is ReleaseCatalogDescriptor {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    isUUIDv7(item.releaseId) &&
    ((item.kind === "BUNDLE" && isUUIDv7(item.bundleId)) ||
      (item.kind === "EMBEDDED" && item.bundleId === null)) &&
    Number.isSafeInteger(item.rolloutCohortCount) &&
    (item.rolloutCohortCount as number) >= 0 &&
    (item.rolloutCohortCount as number) <= NUMERIC_COHORT_SIZE &&
    Array.isArray(item.targetCohorts) &&
    item.targetCohorts.length <= MAX_TARGET_COHORTS_PER_RELEASE &&
    item.targetCohorts.every((cohort) => typeof cohort === "string") &&
    typeof item.shouldForceUpdate === "boolean" &&
    (item.message === null || typeof item.message === "string")
  );
}

type CatalogState = Pick<
  NativeState,
  "platform" | "channelKey" | "appVersion"
> & {
  readonly fingerprintHash?: string | null;
};

function validateCatalog(
  value: unknown,
  state: CatalogState,
  strategy: "app-version" | "fingerprint",
): ReleaseCatalog {
  if (!value || typeof value !== "object") {
    return invalidResponse("Expected a Release catalog.");
  }
  const catalog = value as Partial<ReleaseCatalog>;
  const expectedScope = `v1:${strategy}:${state.platform}:${state.channelKey}`;
  if (
    catalog.schemaVersion !== 1 ||
    typeof catalog.catalogId !== "string" ||
    !catalog.catalogId ||
    catalog.scopeKey !== expectedScope ||
    !Number.isSafeInteger(catalog.generation) ||
    (catalog.generation ?? 0) < 1 ||
    typeof catalog.catalogHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(catalog.catalogHash) ||
    catalog.fallbackPolicy !== "BUILTIN_IF_ACTIVE_INELIGIBLE" ||
    !Array.isArray(catalog.releases) ||
    !catalog.releases.every(descriptor) ||
    (catalog.rollbackReleases !== undefined &&
      (!Array.isArray(catalog.rollbackReleases) ||
        !catalog.rollbackReleases.every(descriptor)))
  ) {
    return invalidResponse(
      "Invalid Release catalog or unexpected catalog scope.",
    );
  }
  const cohorts = new Set(
    [...catalog.releases, ...(catalog.rollbackReleases ?? [])].flatMap(
      (release) => release.targetCohorts,
    ),
  );
  if (cohorts.size > MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE) {
    return invalidResponse("Release catalog exceeds the cohort limit.");
  }
  return catalog as ReleaseCatalog;
}

export function createHttpClient(options: HotUpdaterOptions) {
  const baseURL = () => {
    const url = options.baseURL.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(url)) {
      throw new LynxUpdaterError("INVALID_CONFIG", "baseURL must use HTTP(S).");
    }
    return url;
  };

  async function getJSON(path: string): Promise<unknown> {
    if (typeof fetch !== "function" || typeof AbortController !== "function") {
      throw new LynxUpdaterError(
        "HTTP_UNAVAILABLE",
        "The Lynx background runtime must provide fetch and AbortController.",
      );
    }
    const timeout = options.requestTimeout ?? 5000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new LynxUpdaterError(
        "INVALID_CONFIG",
        "requestTimeout must be positive.",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${baseURL()}${path}`, {
        headers: options.requestHeaders,
        signal: controller.signal,
      });
      if (response.status !== 200) {
        throw new LynxUpdaterError(
          "HTTP_ERROR",
          `Update request returned HTTP ${response.status}.`,
        );
      }
      const body = await response.text();
      let bytes = 0;
      for (const character of body) {
        const code = character.codePointAt(0)!;
        bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
        if (bytes > MAX_RESPONSE_BYTES) {
          return invalidResponse("Update response exceeds the size limit.");
        }
      }
      try {
        return JSON.parse(body) as unknown;
      } catch {
        return invalidResponse("Update response is not valid JSON.");
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new LynxUpdaterError(
          "REQUEST_TIMEOUT",
          "Update request timed out.",
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async fetchCatalog(
      state: CatalogState,
      strategy: "app-version" | "fingerprint" = "app-version",
    ): Promise<ReleaseCatalog> {
      // Native owns Unicode normalization and the exact scope identity.
      if (
        typeof state.channelKey !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(state.channelKey) ||
        state.channelKey.length % 4 === 1
      ) {
        throw new LynxUpdaterError(
          "INVALID_NATIVE_REPLY",
          "Native state did not provide an encoded channel key.",
        );
      }
      const strategyValue =
        strategy === "fingerprint" ? state.fingerprintHash : state.appVersion;
      if (!strategyValue) {
        throw new LynxUpdaterError(
          "UNSUPPORTED_STRATEGY",
          "Native fingerprint hash is unavailable.",
        );
      }
      const path = `/release-catalogs/${strategy}/${state.platform}/${state.channelKey}/${encodeURIComponent(strategyValue)}`;
      return validateCatalog(await getJSON(path), state, strategy);
    },
    async resolveArtifact(
      bundleId: string,
      currentBundleId: string,
    ): Promise<ArchiveArtifact> {
      const value = await getJSON(
        `/artifacts/${encodeURIComponent(bundleId)}/from/${encodeURIComponent(currentBundleId)}`,
      );
      if (!value || typeof value !== "object") {
        return invalidResponse("Expected an update artifact.");
      }
      const artifact = value as Record<string, unknown>;
      if (
        typeof artifact.fileUrl !== "string" ||
        typeof artifact.fileHash !== "string" ||
        !artifact.fileHash
      ) {
        return invalidResponse(
          "Lynx updates require a full archive URL and hash.",
        );
      }
      let fileUrl = artifact.fileUrl;
      if (fileUrl.startsWith("/storage/")) fileUrl = `${baseURL()}${fileUrl}`;
      else if (!/^https?:\/\//i.test(fileUrl)) {
        return invalidResponse(
          "Artifact URLs must use HTTP(S) or a /storage/ path.",
        );
      }
      if (
        artifact.manifestFileHash != null &&
        (typeof artifact.manifestFileHash !== "string" ||
          !artifact.manifestFileHash)
      ) {
        return invalidResponse("Invalid manifest hash.");
      }
      return {
        bundleId,
        fileUrl,
        fileHash: artifact.fileHash,
        manifestFileHash:
          (artifact.manifestFileHash as string | null | undefined) ?? null,
      };
    },
  };
}
