import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { MobileContext } from "./context.ts";

export const RUNNER_VERSIONS = {
  e2e: "0.18.0",
  mobile: "0.10.0",
  agentDevice: "0.21.22",
} as const;

export type CleanupStatus = "passed" | "failed" | "unknown";
export interface MobileResult {
  schemaVersion: 1;
  runner: "mobile";
  runId: string;
  headSha: string;
  profile: string;
  platform: "ios" | "android";
  deviceId: string;
  session: string;
  selectedScenarios: string[];
  status: "passed" | "failed" | "cancelled";
  scenarios: {
    name: string;
    status: "passed" | "failed" | "not_run";
    durationMs: number;
    error?: string;
  }[];
  errors: string[];
  cleanupStatus: CleanupStatus;
  runnerVersions: typeof RUNNER_VERSIONS;
}

export function mobileResultIdentity(context: MobileContext) {
  return {
    runId: context.runId,
    headSha: context.headSha,
    profile: context.profile,
    platform: context.platform,
    deviceId: context.deviceId,
    session: context.session,
    selectedScenarios: [...context.scenarioNames],
  };
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function records(value: unknown): JsonObject[] | undefined {
  return Array.isArray(value) && value.every((row) => object(row))
    ? (value as JsonObject[])
    : undefined;
}

function errorMessage(value: unknown): string {
  const error = object(value);
  return typeof error?.message === "string"
    ? error.message
    : "Malformed SDK error";
}

export interface MobileResultInput {
  report: unknown;
  receipt: unknown;
  evidence: unknown;
  cleanupEvidence: unknown;
  quarantine?: unknown;
  exitCode: number | null;
  cancelled?: boolean;
  cleanupStatus: CleanupStatus;
  errors?: string[];
}

// Exit zero is insufficient: the SDK deliberately does not let reporter failures
// change its verdict. Join its canonical report to our identity and cleanup proof.
export function normalizeMobileResult(
  context: MobileContext,
  input: MobileResultInput,
): MobileResult {
  const errors = [...(input.errors ?? [])];
  const identity = mobileResultIdentity(context);
  let cleanupStatus = input.cleanupStatus;
  const unknownCleanup = () => {
    if (cleanupStatus !== "failed") cleanupStatus = "unknown";
  };
  if (
    !context.scenarioNames.length ||
    new Set(context.scenarioNames).size !== context.scenarioNames.length
  ) {
    errors.push("Scenario selection must be nonempty and unique");
  }
  if (input.exitCode !== 0) {
    errors.push(`SDK process did not exit successfully (${input.exitCode})`);
  }
  if (input.quarantine !== undefined) {
    errors.push("Scenario cleanup requires quarantine");
    unknownCleanup();
  }

  const report = object(input.report);
  const run = object(report?.run);
  const receipt = object(input.receipt);
  if (
    receipt?.schemaVersion !== 1 ||
    !isDeepStrictEqual(receipt.identity, identity) ||
    !isDeepStrictEqual(receipt.report, input.report)
  ) {
    errors.push("SDK reporter receipt is missing or does not match this run");
    unknownCleanup();
  }
  if (report?.schemaVersion !== "report-1" || !run) {
    errors.push("Canonical SDK report is missing or unsupported");
    unknownCleanup();
  }
  if (run?.status !== "passed" || run.exitCode !== 0) {
    errors.push(`SDK run did not pass (${String(run?.status)})`);
  }
  if (object(run?.vcs)?.commit !== context.headSha) {
    errors.push("SDK report commit does not match the requested revision");
    unknownCleanup();
  }
  const runner = object(run?.runner);
  if (runner?.name !== "e2e" || runner.version !== RUNNER_VERSIONS.e2e) {
    errors.push("SDK runner version does not match the pinned version");
  }
  const targets = records(run?.targets);
  const target = targets?.length === 1 ? targets[0] : undefined;
  const engine = object(target?.engine);
  if (
    target?.platform !== context.platform ||
    target.id !== context.platform ||
    engine?.name !== "mobile" ||
    engine.version !== RUNNER_VERSIONS.mobile
  ) {
    errors.push(
      "SDK report target does not match the requested mobile platform",
    );
    unknownCleanup();
  }
  if (!Array.isArray(run?.serialGroups) || run.serialGroups.length !== 0) {
    errors.push("Unexpected serial groups in SDK report");
  }
  const usage = object(run?.usage);
  if (usage?.modelTokens !== 0 || usage.maxModelCallsInStep !== 0) {
    errors.push("SDK report does not prove a model-free run");
  }
  const runErrors = records(run?.errors);
  if (!runErrors) {
    errors.push("SDK report is missing run error records");
    unknownCleanup();
  }
  for (const error of runErrors ?? []) {
    errors.push(`SDK ${String(error.phase ?? "run")}: ${errorMessage(error)}`);
    if (["afterEach", "afterAll", "cleanup"].includes(String(error.phase))) {
      cleanupStatus = "failed";
    }
  }

  const rows = records(run?.results);
  if (!rows) {
    errors.push("SDK report is missing scenario results");
    unknownCleanup();
  }
  const byName = new Map<string, JsonObject[]>();
  const attemptedNames: { name: string; passed: boolean }[] = [];
  for (const row of rows ?? []) {
    const name =
      Array.isArray(row.titlePath) && row.titlePath.length === 1
        ? row.titlePath[0]
        : undefined;
    if (typeof name !== "string" || !context.scenarioNames.includes(name)) {
      errors.push("SDK report contains an unknown scenario");
      unknownCleanup();
      continue;
    }
    byName.set(name, [...(byName.get(name) ?? []), row]);
    const attempts = records(row.attempts);
    if (!attempts || (!attempts.length && row.status !== "skipped")) {
      unknownCleanup();
    }
    for (const attempt of attempts ?? []) {
      attemptedNames.push({ name, passed: attempt.status === "passed" });
      if (attempt.cleanup === "failed") cleanupStatus = "failed";
      else if (attempt.cleanup !== "complete") unknownCleanup();
      for (const error of [
        object(attempt.error),
        ...(records(attempt.secondaryErrors) ?? []),
      ]) {
        if (
          ["afterEach", "afterAll", "cleanup"].includes(String(error?.phase))
        ) {
          cleanupStatus = "failed";
        }
      }
    }
  }
  const cleanupEvidence = object(input.cleanupEvidence);
  const cleanupProofs = records(cleanupEvidence?.attempts);
  if (
    cleanupEvidence?.schemaVersion !== 1 ||
    !cleanupProofs ||
    cleanupProofs.length !== attemptedNames.length ||
    cleanupProofs.some(
      (proof) =>
        proof.cleanupCompleted !== true ||
        (proof.name !== null &&
          (typeof proof.name !== "string" ||
            !attemptedNames.some(({ name }) => name === proof.name))),
    ) ||
    attemptedNames.some(
      ({ name, passed }) =>
        !cleanupProofs.some(
          (proof) => proof.name === name || (!passed && proof.name === null),
        ),
    ) ||
    new Set(cleanupProofs.map((proof) => proof.name)).size !==
      cleanupProofs.length
  ) {
    errors.push(
      "Independent attempt cleanup evidence is missing or incomplete",
    );
    unknownCleanup();
  }
  const evidence = object(input.evidence);
  const proofs = records(evidence?.scenarios);
  if (evidence?.schemaVersion !== 1 || !proofs) {
    errors.push("Scenario evidence is missing or unsupported");
  }
  for (const proof of proofs ?? []) {
    if (!context.scenarioNames.includes(String(proof.name))) {
      errors.push("Evidence contains an unknown scenario");
    }
  }

  const scenarios: MobileResult["scenarios"] = context.scenarioNames.map(
    (name) => {
      const failures: string[] = [];
      const matchingRows = byName.get(name) ?? [];
      const row = matchingRows.length === 1 ? matchingRows[0] : undefined;
      if (!row) {
        failures.push("Expected exactly one SDK scenario result");
        unknownCleanup();
      }
      if (
        row &&
        (row.kind !== "test" ||
          row.selected !== true ||
          row.status !== "passed" ||
          row.repeat !== 0 ||
          row.targetId !== context.platform ||
          row.platform !== context.platform)
      ) {
        failures.push(
          "Scenario was skipped, repeated, failed, or misidentified",
        );
      }
      const attempts = records(row?.attempts);
      const attempt = attempts?.length === 1 ? attempts[0] : undefined;
      if (!attempt || attempt.index !== 0 || attempt.status !== "passed") {
        failures.push("Expected one passing attempt without retries");
      }
      if (attempt?.cleanup !== "complete") {
        failures.push("SDK attempt cleanup did not complete");
      }
      const secondary = records(attempt?.secondaryErrors);
      if (attempt?.error !== undefined) {
        failures.push(errorMessage(attempt.error));
      }
      if (!secondary) failures.push("Missing attempt error records");
      for (const error of secondary ?? []) failures.push(errorMessage(error));
      const steps = records(attempt?.steps);
      if (!steps) failures.push("Missing SDK step records");
      const matches = (proofs ?? []).filter((proof) => proof.name === name);
      const proof = matches.length === 1 ? matches[0] : undefined;
      const insights = object(proof?.consoleInsights);
      if (
        proof?.bodyCompleted !== true ||
        proof.cleanupCompleted !== true ||
        !insights ||
        Object.keys(insights).length === 0
      ) {
        failures.push(
          "Missing scenario body, Console Insights, or cleanup proof",
        );
      }
      // A launch disconnect is expected only when the driver subsequently
      // verifies native recovery. Every other recorded failure is unaccepted.
      const launchFailures = proof?.expectedLaunchFailures;
      const failedSteps = (steps ?? []).filter(
        (step) => step.status !== "passed" || step.error !== undefined,
      );
      if (
        typeof launchFailures !== "number" ||
        !Number.isInteger(launchFailures) ||
        launchFailures < 0 ||
        failedSteps.length !== launchFailures ||
        failedSteps.some(
          (step) =>
            step.status !== "failed" ||
            step.api !== "device.openApp" ||
            !object(step.error),
        )
      ) {
        failures.push("SDK steps contain an unverified failure");
      }
      const duration = attempt?.durationMs;
      if (
        typeof duration !== "number" ||
        !Number.isFinite(duration) ||
        duration < 0
      ) {
        failures.push("Invalid SDK attempt duration");
      }
      errors.push(...failures.map((failure) => `${name}: ${failure}`));
      return {
        name,
        status: !row ? "not_run" : failures.length ? "failed" : "passed",
        durationMs:
          typeof duration === "number" &&
          Number.isFinite(duration) &&
          duration >= 0
            ? duration
            : 0,
        ...(failures.length ? { error: failures.join("; ") } : {}),
      };
    },
  );
  const summary = object(run?.summary);
  const count = context.scenarioNames.length;
  if (
    !summary ||
    ["discovered", "selected", "executed", "passed"].some(
      (key) => summary[key] !== count,
    ) ||
    ["failed", "flaky", "skipped"].some((key) => summary[key] !== 0)
  ) {
    errors.push("SDK summary does not cover exactly the selected scenarios");
  }
  if (cleanupStatus !== "passed") {
    errors.push(`Run cleanup is ${cleanupStatus}`);
  }
  return {
    schemaVersion: 1,
    runner: "mobile",
    ...identity,
    status: input.cancelled ? "cancelled" : errors.length ? "failed" : "passed",
    scenarios,
    errors,
    cleanupStatus,
    runnerVersions: { ...RUNNER_VERSIONS },
  };
}

export async function writeMobileResult(
  context: MobileContext,
  result: MobileResult,
): Promise<void> {
  await mkdir(context.resultsDir, { recursive: true });
  const target = path.join(context.resultsDir, "hot-updater-result.json");
  await writeFile(`${target}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
  await rename(`${target}.tmp`, target);
}
