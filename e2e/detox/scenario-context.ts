import path from "node:path";

export type DetoxPlatform = "android" | "ios";

export type StageTiming = {
  readonly diagnostic?: string;
  readonly durationMs: number;
  readonly endedAtMs: number;
  readonly outcome: "failed" | "succeeded";
  readonly stage: string;
  readonly startedAtMs: number;
};

export type FailureArtifactKind =
  | "detox-log"
  | "jest-json"
  | "junit"
  | "runtime-log"
  | "screenshot"
  | "view-hierarchy";

export type FailureArtifact = {
  readonly kind: FailureArtifactKind;
  readonly label: string;
  readonly path: string;
};

export type ScenarioBundleIds = {
  readonly builtInBundleId?: string;
  readonly crashedBundleId?: string;
  readonly previousBundleId?: string;
  readonly stableBundleId?: string;
};

export type DetoxScenarioContext = {
  readonly artifactsDir: string;
  readonly bundleIds: ScenarioBundleIds;
  readonly channel: string;
  readonly failureArtifacts: readonly FailureArtifact[];
  readonly platform: DetoxPlatform;
  readonly scenarioName: string;
  readonly stageTimings: readonly StageTiming[];
  readonly targetAppVersion: string;
};

export type CreateScenarioContextInput = {
  readonly artifactsDir: string;
  readonly bundleIds?: ScenarioBundleIds;
  readonly channel: string;
  readonly platform: DetoxPlatform;
  readonly scenarioName: string;
  readonly targetAppVersion: string;
};

export type ResolveArtifactsDirInput = {
  readonly artifactsRoot: string;
  readonly jobId: string;
};

export function resolveDetoxArtifactsDir(
  input: ResolveArtifactsDirInput,
): string {
  const jobRoot =
    path.basename(input.artifactsRoot) === input.jobId
      ? input.artifactsRoot
      : path.join(input.artifactsRoot, input.jobId);
  return path.join(jobRoot, "detox");
}

export function createScenarioContext(
  input: CreateScenarioContextInput,
): DetoxScenarioContext {
  return {
    artifactsDir: input.artifactsDir,
    bundleIds: input.bundleIds ?? {},
    channel: input.channel,
    failureArtifacts: [],
    platform: input.platform,
    scenarioName: input.scenarioName,
    stageTimings: [],
    targetAppVersion: input.targetAppVersion,
  };
}

export function addFailureArtifact(
  context: DetoxScenarioContext,
  artifact: FailureArtifact,
): DetoxScenarioContext {
  return {
    ...context,
    failureArtifacts: [
      ...context.failureArtifacts,
      {
        ...artifact,
        path: path.join(context.artifactsDir, path.basename(artifact.path)),
      },
    ],
  };
}

export function addStageTiming(
  context: DetoxScenarioContext,
  timing: StageTiming,
): DetoxScenarioContext {
  return {
    ...context,
    stageTimings: [...context.stageTimings, timing],
  };
}
