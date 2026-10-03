import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export type ArtifactSelectionEvidence = {
  readonly assetCount: number;
  readonly assetDescriptorsComplete: boolean;
  readonly assetFileCount: number;
  readonly assetFilePaths: readonly string[];
  readonly assetPatchCount: number;
  readonly assetPatchPaths: readonly string[];
  readonly assetsPresent: boolean;
  readonly artifactProtocolVersion: number | null;
  readonly immutableFingerprint: string;
  readonly manifestFileHashPresent: boolean;
  readonly manifestUrlPresent: boolean;
  readonly unpatchedAssetPaths: readonly string[];
};

export type ManifestDiffSelectionEvidence = ArtifactSelectionEvidence;

export type CapturedArtifactSelectionEvidence = ArtifactSelectionEvidence & {
  readonly currentBundleId: string;
  readonly targetBundleId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type ArtifactFileTransferMode = "manifest-diff" | "archive";

/** Derive expected original-file transfers independently of observed requests. */
export function getExpectedArtifactFilePaths(input: {
  assets: readonly {
    path: string;
    fileHash: string;
    patchUrl: string | null;
  }[];
  baseManifest: unknown;
  mode: ArtifactFileTransferMode;
  preflightAssetPaths: readonly string[];
}): string[] {
  const preflight = new Set(input.preflightAssetPaths);
  if (
    [...preflight].some(
      (path) => !input.assets.some((asset) => asset.path === path),
    )
  ) {
    throw new Error("Required preflight asset is missing from the target");
  }
  if (input.mode === "archive") return [...preflight].sort();
  if (!isRecord(input.baseManifest) || !isRecord(input.baseManifest.assets)) {
    throw new Error(
      "A valid native base manifest is required for transfer expectations",
    );
  }
  const base = input.baseManifest.assets;
  return input.assets
    .filter((asset) => {
      const previous = base[asset.path];
      let reused = false;
      if (previous !== undefined) {
        if (!isRecord(previous) || !isNonEmptyString(previous.fileHash)) {
          throw new Error(`Invalid native base asset: ${asset.path}`);
        }
        reused =
          previous.fileHash.toLowerCase() === asset.fileHash.toLowerCase();
      }
      return preflight.has(asset.path) || (!reused && asset.patchUrl === null);
    })
    .map((asset) => asset.path)
    .sort();
}

function isRenewableUrl(path: readonly string[], key: string) {
  if (path.length === 0) {
    return key === "archiveUrl" || key === "manifestUrl";
  }
  if (path.length === 3 && path[0] === "assets" && path[2] === "file") {
    return key === "url";
  }
  return (
    path.length === 3 &&
    path[0] === "assets" &&
    path[2] === "patch" &&
    key === "patchUrl"
  );
}

function canonicalizeImmutableSelection(
  value: unknown,
  path: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeImmutableSelection(entry, path));
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .flatMap((key) => {
        const entry = value[key];
        if (entry === undefined) return [];
        return [
          [
            key,
            isRenewableUrl(path, key) && typeof entry === "string"
              ? "<renewable-url>"
              : canonicalizeImmutableSelection(entry, [...path, key]),
          ],
        ];
      }),
  );
}

function readAsset(entry: unknown) {
  if (!isRecord(entry) || !isNonEmptyString(entry.fileHash)) {
    return { complete: false, file: false, patch: false };
  }

  const file =
    isRecord(entry.file) &&
    isNonEmptyString(entry.file.url) &&
    (entry.file.compression === undefined ||
      entry.file.compression === null ||
      entry.file.compression === "br");
  const patchAbsent = entry.patch === undefined || entry.patch === null;
  const patch =
    isRecord(entry.patch) &&
    entry.patch.algorithm === "bsdiff" &&
    isNonEmptyString(entry.patch.baseBundleId) &&
    isNonEmptyString(entry.patch.baseFileHash) &&
    isNonEmptyString(entry.patch.patchFileHash) &&
    isNonEmptyString(entry.patch.patchUrl);

  return {
    complete: file && (patchAbsent || patch),
    file,
    patch,
  };
}

export function captureArtifactSelectionEvidence(
  payload: unknown,
): ManifestDiffSelectionEvidence | null {
  if (!isRecord(payload)) return null;

  const assetsPresent = payload.assets !== undefined && payload.assets !== null;
  const assets = isRecord(payload.assets) ? Object.entries(payload.assets) : [];
  const descriptors = assets.map(([path, entry]) => ({
    path,
    ...readAsset(entry),
  }));
  const assetFilePaths = descriptors.flatMap((entry) =>
    entry.file ? [entry.path] : [],
  );
  const assetPatchPaths = descriptors.flatMap((entry) =>
    entry.patch ? [entry.path] : [],
  );

  return {
    assetCount: assets.length,
    assetDescriptorsComplete:
      (!assetsPresent || isRecord(payload.assets)) &&
      descriptors.every((entry) => entry.complete),
    assetFileCount: assetFilePaths.length,
    assetFilePaths,
    assetPatchCount: assetPatchPaths.length,
    assetPatchPaths,
    assetsPresent,
    artifactProtocolVersion:
      typeof payload.artifactProtocolVersion === "number"
        ? payload.artifactProtocolVersion
        : null,
    immutableFingerprint: createHash("sha256")
      .update(JSON.stringify(canonicalizeImmutableSelection(payload)))
      .digest("hex"),
    manifestFileHashPresent: isNonEmptyString(payload.manifestFileHash),
    manifestUrlPresent: isNonEmptyString(payload.manifestUrl),
    unpatchedAssetPaths: assetFilePaths.filter(
      (path) => !assetPatchPaths.includes(path),
    ),
  };
}

export function classifyArtifactSelection(
  evidence: ArtifactSelectionEvidence,
): "manifest-v1" | null {
  if (
    evidence.artifactProtocolVersion === 1 &&
    evidence.assetsPresent &&
    evidence.assetCount > 0 &&
    evidence.assetDescriptorsComplete &&
    evidence.manifestFileHashPresent &&
    evidence.manifestUrlPresent
  ) {
    return "manifest-v1";
  }
  return null;
}

export function classifyArtifactSelectionHistory(
  evidence: readonly ManifestDiffSelectionEvidence[],
): "manifest-v1" | null {
  const selection = evidence[0] ? classifyArtifactSelection(evidence[0]) : null;
  if (
    selection === null ||
    evidence.some((entry) => classifyArtifactSelection(entry) !== selection)
  ) {
    return null;
  }
  const fingerprint = evidence[0]!.immutableFingerprint;
  return evidence.every((entry) => entry.immutableFingerprint === fingerprint)
    ? selection
    : null;
}

export async function collectManifestDiffLogs(input: {
  platform: "android" | "ios";
  readAndroidArchiveLogs: () => string;
  readAndroidBsdiffLogs: () => string;
  readAndroidNativeLogs: () => string;
  readIosLogs: () => Promise<string>;
}) {
  if (input.platform === "ios") {
    const logs = await input.readIosLogs();
    return {
      archiveLogs: logs,
      bsdiffLogs: logs,
      nativeLogs: logs,
    };
  }

  return {
    archiveLogs: input.readAndroidArchiveLogs(),
    bsdiffLogs: input.readAndroidBsdiffLogs(),
    nativeLogs: input.readAndroidNativeLogs(),
  };
}

export async function captureCommandWithDeadline(
  command: string,
  args: readonly string[],
  options: {
    allowFailure?: boolean;
    maxBuffer?: number;
    signal?: AbortSignal;
    timeoutMs: number;
  },
) {
  if (options.signal?.aborted) {
    throw options.signal.reason;
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminationError: unknown;

    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      terminationError = options.signal?.reason;
      kill();
    };
    const timer = setTimeout(() => {
      terminationError = new Error(
        `${command} timed out after ${options.timeoutMs}ms`,
      );
      kill();
    }, options.timeoutMs);
    timer.unref();
    options.signal?.addEventListener("abort", abort, { once: true });

    const append = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > (options.maxBuffer ?? 1024 * 1024)) {
        terminationError = new Error(`${command} exceeded its output limit`);
        kill();
        return;
      }
      output.push(chunk);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      finish(() => {
        if (terminationError !== undefined) {
          reject(terminationError);
          return;
        }
        if (code !== 0 && !options.allowFailure) {
          reject(new Error(`${command} failed with code ${code}`));
          return;
        }
        resolve(Buffer.concat(output).toString("utf8").trim());
      });
    });
  });
}
