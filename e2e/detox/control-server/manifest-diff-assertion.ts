import { spawn } from "node:child_process";

export type ArtifactSelectionEvidence = {
  readonly changedAssetCount: number;
  readonly changedAssetsPresent: boolean;
  readonly fileHashPresent: boolean;
  readonly fileUrlPresent: boolean;
  readonly manifestFileHashPresent: boolean;
  readonly manifestUrlPresent: boolean;
};

export type ManifestDiffSelectionEvidence = ArtifactSelectionEvidence & {
  readonly changedAssetFileCount: number;
  readonly changedAssetFilePaths: readonly string[];
  readonly changedAssetPatchCount: number;
  readonly changedAssetPatchPaths: readonly string[];
  readonly rawChangedAssetPaths: readonly string[];
};

export function classifyArtifactSelection(
  evidence: ArtifactSelectionEvidence,
): "archive-only" | "manifest-diff" | null {
  if (
    evidence.changedAssetsPresent &&
    evidence.changedAssetCount > 0 &&
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

function manifestDiffSelectionFingerprint(
  evidence: ManifestDiffSelectionEvidence,
) {
  return JSON.stringify({
    changedAssetCount: evidence.changedAssetCount,
    changedAssetFileCount: evidence.changedAssetFileCount,
    changedAssetFilePaths: evidence.changedAssetFilePaths.toSorted(),
    changedAssetPatchCount: evidence.changedAssetPatchCount,
    changedAssetPatchPaths: evidence.changedAssetPatchPaths.toSorted(),
    fileHashPresent: evidence.fileHashPresent,
    fileUrlPresent: evidence.fileUrlPresent,
    rawChangedAssetPaths: evidence.rawChangedAssetPaths.toSorted(),
  });
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
  if (selection === "archive-only") {
    return selection;
  }

  const fingerprint = manifestDiffSelectionFingerprint(evidence[0]!);
  return evidence.every(
    (entry) => manifestDiffSelectionFingerprint(entry) === fingerprint,
  )
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
