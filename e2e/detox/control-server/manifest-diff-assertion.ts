import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export type ArtifactSelectionEvidence = {
  readonly changedAssetCount: number;
  readonly changedAssetDescriptorsComplete: boolean;
  readonly changedAssetFileCount: number;
  readonly changedAssetFilePaths: readonly string[];
  readonly changedAssetPatchCount: number;
  readonly changedAssetPatchPaths: readonly string[];
  readonly changedAssetsPresent: boolean;
  readonly fileHashPresent: boolean;
  readonly fileUrlPresent: boolean;
  readonly immutableFingerprint: string;
  readonly manifestFileHashPresent: boolean;
  readonly manifestUrlPresent: boolean;
  readonly rawChangedAssetPaths: readonly string[];
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

function isRenewableUrl(path: readonly string[], key: string) {
  if (path.length === 0) {
    return key === "fileUrl" || key === "manifestUrl";
  }
  if (path.length === 3 && path[0] === "changedAssets" && path[2] === "file") {
    return key === "url";
  }
  return (
    path.length === 3 &&
    path[0] === "changedAssets" &&
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

function readChangedAsset(entry: unknown) {
  if (!isRecord(entry) || !isNonEmptyString(entry.fileHash)) {
    return { complete: false, file: false, patch: false };
  }

  const fileAbsent = entry.file === undefined || entry.file === null;
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
    complete: (fileAbsent || file) && (patchAbsent || patch) && (file || patch),
    file,
    patch,
  };
}

export function captureArtifactSelectionEvidence(
  payload: unknown,
): ManifestDiffSelectionEvidence | null {
  if (!isRecord(payload)) return null;

  const changedAssetsPresent =
    payload.changedAssets !== undefined && payload.changedAssets !== null;
  const changedAssets = isRecord(payload.changedAssets)
    ? Object.entries(payload.changedAssets)
    : [];
  const descriptors = changedAssets.map(([path, entry]) => ({
    path,
    ...readChangedAsset(entry),
  }));
  const changedAssetFilePaths = descriptors.flatMap((entry) =>
    entry.file ? [entry.path] : [],
  );
  const changedAssetPatchPaths = descriptors.flatMap((entry) =>
    entry.patch ? [entry.path] : [],
  );

  return {
    changedAssetCount: changedAssets.length,
    changedAssetDescriptorsComplete:
      (!changedAssetsPresent || isRecord(payload.changedAssets)) &&
      descriptors.every((entry) => entry.complete),
    changedAssetFileCount: changedAssetFilePaths.length,
    changedAssetFilePaths,
    changedAssetPatchCount: changedAssetPatchPaths.length,
    changedAssetPatchPaths,
    changedAssetsPresent,
    fileHashPresent: isNonEmptyString(payload.fileHash),
    fileUrlPresent: isNonEmptyString(payload.fileUrl),
    immutableFingerprint: createHash("sha256")
      .update(JSON.stringify(canonicalizeImmutableSelection(payload)))
      .digest("hex"),
    manifestFileHashPresent: isNonEmptyString(payload.manifestFileHash),
    manifestUrlPresent: isNonEmptyString(payload.manifestUrl),
    rawChangedAssetPaths: changedAssetFilePaths.filter(
      (path) => !changedAssetPatchPaths.includes(path),
    ),
  };
}

export function classifyArtifactSelection(
  evidence: ArtifactSelectionEvidence,
): "archive-only" | "manifest-diff" | null {
  if (
    evidence.changedAssetsPresent &&
    evidence.changedAssetCount > 0 &&
    evidence.changedAssetDescriptorsComplete &&
    evidence.manifestFileHashPresent &&
    evidence.manifestUrlPresent
  ) {
    return "manifest-diff";
  }
  if (
    evidence.fileUrlPresent &&
    evidence.fileHashPresent &&
    !evidence.changedAssetsPresent &&
    !evidence.manifestFileHashPresent &&
    !evidence.manifestUrlPresent
  ) {
    return "archive-only";
  }
  return null;
}

export function classifyArtifactSelectionHistory(
  evidence: readonly ManifestDiffSelectionEvidence[],
): "archive-only" | "manifest-diff" | null {
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

export function isExactLynxFirstOtaArchiveSelection(input: {
  readonly builtInBundleId: string;
  readonly selections: readonly CapturedArtifactSelectionEvidence[];
  readonly targetBundleId: string;
}): boolean {
  return (
    input.selections.length > 0 &&
    input.selections.every(
      (entry) =>
        entry.currentBundleId === input.builtInBundleId &&
        entry.targetBundleId === input.targetBundleId,
    ) &&
    classifyArtifactSelectionHistory(input.selections) === "archive-only"
  );
}

export function hasLynxFirstOtaArchiveEvidence(input: {
  readonly builtInBundleId: string;
  readonly bundleFileExists: boolean;
  readonly selections: readonly CapturedArtifactSelectionEvidence[];
  readonly stableBundleId: string | null;
  readonly stagingBundleId: string | null;
  readonly stagingSelectionBundleId: string | null;
  readonly targetBundleId: string;
  readonly verificationPending: boolean | null;
}): boolean {
  return (
    isExactLynxFirstOtaArchiveSelection(input) &&
    input.stagingBundleId === input.targetBundleId &&
    input.stagingSelectionBundleId === input.targetBundleId &&
    input.verificationPending === true &&
    input.stableBundleId !== input.targetBundleId &&
    input.bundleFileExists
  );
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
