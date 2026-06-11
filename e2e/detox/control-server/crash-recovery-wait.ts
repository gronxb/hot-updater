export type CrashRecoveryPlatform = "android" | "ios";

export type JsonSnapshot = {
  readonly exists: boolean;
  readonly path: string;
  readonly readError: string | null;
  readonly value: Record<string, unknown> | null;
};

export type CrashRecoveryDiagnostics = {
  readonly crashHistory: JsonSnapshot;
  readonly crashMarker: JsonSnapshot;
  readonly launchReport: JsonSnapshot;
  readonly metadata: JsonSnapshot;
};

export type MetadataState = {
  readonly stagingBundleId: string | null;
  readonly verificationPending: boolean | null;
};

export type LaunchReportState = {
  readonly crashedBundleId: string | null;
  readonly status: string | null;
};

export type CrashRecoveryArtifactNames = {
  readonly crashHistory: string;
  readonly crashMarker: string;
  readonly launchReport: string;
  readonly metadata: string;
};

export type CrashRecoveryTimeoutDetails = {
  readonly attempts: number;
  readonly crashedBundleId: string;
  readonly crashHistory: JsonSnapshot;
  readonly crashMarker: JsonSnapshot;
  readonly launchReport: JsonSnapshot;
  readonly metadata: JsonSnapshot;
  readonly stableBundleId: string;
};

export type CrashRecoveryWaitOptions = {
  readonly androidLaunchSettleMs: number;
  readonly attempts: number;
  readonly crashedBundleId: string;
  readonly createTimeoutError: (details: CrashRecoveryTimeoutDetails) => Error;
  readonly getLaunchReportState: (
    report: Record<string, unknown> | null,
  ) => LaunchReportState;
  readonly getMetadataState: (
    metadata: Record<string, unknown> | null,
  ) => MetadataState;
  readonly launchAndroidApp: () => void;
  readonly platform: CrashRecoveryPlatform;
  readonly pollIntervalMs: number;
  readonly readDiagnostics: (
    artifactNames: CrashRecoveryArtifactNames,
  ) => CrashRecoveryDiagnostics;
  readonly signal?: AbortSignal;
  readonly sleepMs: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  readonly stableBundleId: string;
};

function sanitizeArtifactSegment(value: string): string {
  const sanitized = value
    .replace(/[^0-9A-Za-z._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "unknown";
}

export function createCrashRecoveryArtifactNames(args: {
  readonly crashedBundleId: string;
  readonly stableBundleId: string;
}): CrashRecoveryArtifactNames {
  const stableBundleId = sanitizeArtifactSegment(args.stableBundleId);
  const crashedBundleId = sanitizeArtifactSegment(args.crashedBundleId);
  const prefix = `crash-recovery-${stableBundleId}-${crashedBundleId}`;

  return {
    crashHistory: `${prefix}-crash-history.json`,
    crashMarker: `${prefix}-crash-marker.json`,
    launchReport: `${prefix}-launch-report.json`,
    metadata: `${prefix}-metadata.json`,
  };
}

function getAbortSignalReason(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }
  return "cancelled";
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error(`Control job cancelled: ${getAbortSignalReason(signal)}`);
  }
}

function isRecovered(args: {
  readonly crashedBundleId: string;
  readonly launchReportState: LaunchReportState;
  readonly metadataState: MetadataState;
  readonly stableBundleId: string;
}) {
  return (
    args.metadataState.stagingBundleId === args.stableBundleId &&
    args.metadataState.verificationPending === false &&
    args.launchReportState.status === "RECOVERED" &&
    args.launchReportState.crashedBundleId === args.crashedBundleId
  );
}

export async function waitForCrashRecoveryState(
  options: CrashRecoveryWaitOptions,
) {
  const artifactNames = createCrashRecoveryArtifactNames({
    crashedBundleId: options.crashedBundleId,
    stableBundleId: options.stableBundleId,
  });
  let androidRelaunchAttempts = 0;

  for (let index = 0; index < options.attempts; index += 1) {
    throwIfAborted(options.signal);
    const diagnostics = options.readDiagnostics(artifactNames);
    const metadataState = options.getMetadataState(diagnostics.metadata.value);
    const launchReportState = options.getLaunchReportState(
      diagnostics.launchReport.value,
    );

    if (
      isRecovered({
        crashedBundleId: options.crashedBundleId,
        launchReportState,
        metadataState,
        stableBundleId: options.stableBundleId,
      })
    ) {
      return {};
    }

    if (options.platform === "android" && androidRelaunchAttempts < 3) {
      options.launchAndroidApp();
      androidRelaunchAttempts += 1;
      await options.sleepMs(options.androidLaunchSettleMs, options.signal);
      continue;
    }

    await options.sleepMs(options.pollIntervalMs, options.signal);
  }

  throwIfAborted(options.signal);
  const diagnostics = options.readDiagnostics(artifactNames);
  throw options.createTimeoutError({
    attempts: options.attempts,
    crashedBundleId: options.crashedBundleId,
    ...diagnostics,
    stableBundleId: options.stableBundleId,
  });
}
