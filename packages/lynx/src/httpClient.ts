import {
  isUUIDv7,
  MAX_COMPILED_CATALOG_BYTES,
  MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE,
  MAX_TARGET_COHORTS_PER_RELEASE,
  MAX_UPDATE_ARTIFACT_RESPONSE_BYTES,
  NUMERIC_COHORT_SIZE,
  type ReleaseCatalog,
  type ReleaseCatalogDescriptor,
} from "@hot-updater/core";

import { LynxUpdaterError } from "./native";
import type {
  HotUpdaterOptions,
  NativeState,
  UpdateArtifact,
  UpdateChangedAsset,
} from "./types";

const MAX_CATALOG_RESPONSE_BYTES = MAX_COMPILED_CATALOG_BYTES * 2 + 4096;

const invalidResponse = (message: string): never => {
  throw new LynxUpdaterError("INVALID_RESPONSE", message);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);

const isIntegrityToken = (value: unknown): value is string =>
  isHash(value) ||
  (typeof value === "string" &&
    value.length > 4 &&
    /^sig:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    ));

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function contentLength(response: Response): number | null {
  const value = response.headers?.get?.("content-length") ?? null;
  if (value === null) return null;
  if (!/^\d+$/.test(value)) {
    return invalidResponse("Invalid Content-Length response header.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return invalidResponse("Invalid Content-Length response header.");
  }
  return parsed;
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // The size violation remains the authoritative failure.
  }
}

async function readBoundedBody(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  const declaredLength = contentLength(response);
  if (declaredLength !== null && declaredLength > maxResponseBytes) {
    await cancelBody(response.body);
    return invalidResponse("Update response exceeds the size limit.");
  }

  const body = response.body;
  if (
    body !== null &&
    typeof body.getReader === "function" &&
    typeof TextDecoder === "function"
  ) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxResponseBytes) {
          try {
            await reader.cancel();
          } catch {
            // The size violation remains the authoritative failure.
          }
          return invalidResponse("Update response exceeds the size limit.");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(content);
  }

  if (declaredLength === null) {
    await cancelBody(body);
    return invalidResponse(
      "A bounded Content-Length header is required without response streaming.",
    );
  }
  const text = await response.text();
  if (utf8ByteLength(text) > maxResponseBytes) {
    return invalidResponse("Update response exceeds the size limit.");
  }
  return text;
}

function hasUnsafeUrlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || character === "\\") return true;
  }
  return false;
}

function hasUnsafeAssetPathCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const code = value.charCodeAt(index);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      character === "\\" ||
      character === ":"
    ) {
      return true;
    }
  }
  return false;
}

// Lynx background runtimes need not provide the WHATWG URL constructor.
function resolveArtifactUrl(baseURL: string, value: unknown): string {
  if (typeof value !== "string") {
    return invalidResponse("Artifact URLs must be strings.");
  }
  const url = value.startsWith("/storage/") ? `${baseURL}${value}` : value;
  const match =
    /^https?:\/\/(\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(?:[/?#].*)?$/i.exec(
      url,
    );
  if (
    hasUnsafeUrlCharacter(url) ||
    !match ||
    (match[2] !== undefined && Number(match[2]) > 65535)
  ) {
    return invalidResponse(
      "Artifact URLs must use HTTP(S) or a /storage/ path without credentials.",
    );
  }
  return url;
}

function parseChangedAssets(
  baseURL: string,
  value: unknown,
): Record<string, UpdateChangedAsset> {
  if (!isObject(value) || Object.keys(value).length > 10_000) {
    return invalidResponse("Invalid changed asset map.");
  }
  return Object.fromEntries(
    Object.entries(value).map(([assetPath, asset]) => {
      if (
        !assetPath ||
        assetPath === "manifest.json" ||
        hasUnsafeAssetPathCharacter(assetPath) ||
        assetPath
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        !isObject(asset) ||
        asset.file === undefined ||
        asset.patch === undefined ||
        !isHash(asset.fileHash)
      ) {
        return invalidResponse("Invalid changed asset path or hash.");
      }
      let file: UpdateChangedAsset["file"] = null;
      if (asset.file != null) {
        if (
          !isObject(asset.file) ||
          (asset.file.compression !== null && asset.file.compression !== "br")
        ) {
          return invalidResponse("Invalid changed asset file descriptor.");
        }
        file = {
          url: resolveArtifactUrl(baseURL, asset.file.url),
          compression: asset.file.compression,
        };
      }
      let patch: UpdateChangedAsset["patch"] = null;
      if (asset.patch != null) {
        if (
          !isObject(asset.patch) ||
          asset.patch.algorithm !== "bsdiff" ||
          !isUUIDv7(asset.patch.baseBundleId) ||
          !isHash(asset.patch.baseFileHash) ||
          !isHash(asset.patch.patchFileHash)
        ) {
          return invalidResponse("Invalid changed asset patch descriptor.");
        }
        patch = {
          algorithm: "bsdiff",
          baseBundleId: asset.patch.baseBundleId,
          baseFileHash: asset.patch.baseFileHash,
          patchFileHash: asset.patch.patchFileHash,
          patchUrl: resolveArtifactUrl(baseURL, asset.patch.patchUrl),
        };
      }
      if (!file && !patch) {
        return invalidResponse("A changed asset requires a file or patch.");
      }
      return [assetPath, { fileHash: asset.fileHash, file, patch }];
    }),
  );
}

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
  const expectedScope =
    strategy === "fingerprint"
      ? `v1:fingerprint:${state.platform}:${state.channelKey}:${state.fingerprintHash}`
      : `v1:app-version:${state.platform}:${state.channelKey}`;
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

  async function getJSON(
    path: string,
    maxResponseBytes: number,
  ): Promise<unknown> {
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
    let timedOut = false;
    const timeoutError = () =>
      new LynxUpdaterError("REQUEST_TIMEOUT", "Update request timed out.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError());
      }, timeout);
    });
    try {
      const response = await Promise.race([
        fetch(`${baseURL()}${path}`, {
          headers: options.requestHeaders,
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
      if (response.status !== 200) {
        throw new LynxUpdaterError(
          "HTTP_ERROR",
          `Update request returned HTTP ${response.status}.`,
        );
      }
      const body = await readBoundedBody(response, maxResponseBytes);
      try {
        return JSON.parse(body) as unknown;
      } catch {
        return invalidResponse("Update response is not valid JSON.");
      }
    } catch (error) {
      if (timedOut || controller.signal.aborted) {
        throw timeoutError();
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
      return validateCatalog(
        await getJSON(path, MAX_CATALOG_RESPONSE_BYTES),
        state,
        strategy,
      );
    },
    async resolveArtifact(
      bundleId: string,
      currentBundleId: string,
    ): Promise<UpdateArtifact> {
      const value = await getJSON(
        `/artifacts/${encodeURIComponent(bundleId)}/from/${encodeURIComponent(currentBundleId)}`,
        MAX_UPDATE_ARTIFACT_RESPONSE_BYTES,
      );
      if (!isObject(value)) {
        return invalidResponse("Expected an update artifact.");
      }
      const artifact = value;
      let fileUrl: string | null = null;
      let fileHash: string | null = null;
      if (artifact.fileUrl != null || artifact.fileHash != null) {
        if (!isIntegrityToken(artifact.fileHash)) {
          return invalidResponse("Invalid archive integrity token.");
        }
        fileUrl = resolveArtifactUrl(baseURL(), artifact.fileUrl);
        fileHash = artifact.fileHash;
      }
      if (
        artifact.manifestFileHash != null &&
        !isIntegrityToken(artifact.manifestFileHash)
      ) {
        return invalidResponse("Invalid manifest integrity token.");
      }
      const manifestFileHash =
        (artifact.manifestFileHash as string | null | undefined) ?? null;
      let manifestUrl: string | null = null;
      let changedAssets: Record<string, UpdateChangedAsset> | null = null;
      if (artifact.manifestUrl != null || artifact.changedAssets != null) {
        if (!manifestFileHash) {
          return invalidResponse(
            "Manifest updates require an integrity token.",
          );
        }
        manifestUrl = resolveArtifactUrl(baseURL(), artifact.manifestUrl);
        changedAssets = parseChangedAssets(baseURL(), artifact.changedAssets);
      }
      if (manifestUrl !== null) {
        if (manifestFileHash === null || changedAssets === null) {
          return invalidResponse("Incomplete manifest update.");
        }
        if (fileUrl !== null) {
          if (fileHash === null) {
            return invalidResponse("Incomplete archive update.");
          }
          return {
            bundleId,
            fileUrl,
            fileHash,
            manifestUrl,
            manifestFileHash,
            changedAssets,
          };
        }
        return {
          bundleId,
          fileUrl: null,
          fileHash: null,
          manifestUrl,
          manifestFileHash,
          changedAssets,
        };
      }
      if (fileUrl === null || fileHash === null) {
        return invalidResponse(
          "An archive or complete manifest update is required.",
        );
      }
      return {
        bundleId,
        fileUrl,
        fileHash,
        manifestUrl: null,
        manifestFileHash,
        changedAssets: null,
      };
    },
  };
}
