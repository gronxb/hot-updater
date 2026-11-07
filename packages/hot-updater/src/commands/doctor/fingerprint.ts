import fs from "node:fs";
import path from "node:path";

import {
  describeFingerprintEngineChange,
  ensureFingerprintConfig,
  type FingerprintResult,
  generateFingerprints,
  getFingerprintDiff,
  getFingerprintEngineChange,
  summarizeFingerprintDiff,
} from "../../utils/fingerprint";
import { isNativeSdkWithoutBuildFingerprintError } from "../../utils/fingerprint/nativeSdk";
import type { NativeCheckIssue } from "./issues";

const FINGERPRINT_CREATE = "npx hot-updater fingerprint create";

const PLATFORM_LABELS = { ios: "iOS", android: "Android" } as const;

const generationFailed = (error: unknown): NativeCheckIssue => {
  const message = error instanceof Error ? error.message : String(error);
  if (isNativeSdkWithoutBuildFingerprintError(error)) {
    return {
      type: "error",
      platform: "project",
      code: "FINGERPRINT_GENERATION_FAILED",
      message,
      resolution:
        "Update @hot-updater/react-native to the version of hot-updater, then rebuild the app and rerun doctor.",
      paths: ["package.json"],
    };
  }
  return {
    type: "error",
    platform: "project",
    code: "FINGERPRINT_GENERATION_FAILED",
    message: `Could not compute the project's fingerprint: ${message}`,
    resolution:
      "Check the fingerprint settings in hot-updater.config.ts, then rerun doctor.",
    paths: ["hot-updater.config.ts"],
  };
};

/**
 * Compares fingerprint.json with the project's fingerprint as
 * `fingerprint create` computes it: FINGERPRINT_JSON_STALE for each
 * platform whose hash changed, with the sources that changed, or
 * FINGERPRINT_ENGINE_CHANGED when the engine that computes it changed.
 * `fingerprints` gives that fingerprint; a doctor run computes it once.
 */
export const checkFingerprintJson = async (
  local: {
    readonly ios?: FingerprintResult | null;
    readonly android?: FingerprintResult | null;
  },
  fingerprints: () => ReturnType<
    typeof generateFingerprints
  > = generateFingerprints,
): Promise<NativeCheckIssue[]> => {
  let current: Awaited<ReturnType<typeof generateFingerprints>>;
  try {
    current = await fingerprints();
  } catch (error) {
    return [generationFailed(error)];
  }

  const issues: NativeCheckIssue[] = [];
  for (const platform of ["ios", "android"] as const) {
    const before = local[platform];
    const label = PLATFORM_LABELS[platform];
    if (before?.hash === current[platform].hash) {
      // Without the current engine recorded, a later native change would read
      // as an engine change, or an engine upgrade as changed sources.
      const engine = current[platform].engine;
      if (engine && before.engine !== engine) {
        issues.push({
          type: "warning",
          platform,
          code: "FINGERPRINT_ENGINE_UNRECORDED",
          message: before.engine
            ? `fingerprint.json records ${before.engine} for the ${label} fingerprint, which ${engine} now computes unchanged.`
            : `fingerprint.json doesn't record the engine behind the ${label} fingerprint, which ${engine} computes unchanged.`,
          resolution: `Run \`${FINGERPRINT_CREATE}\` to record it, so doctor and deploy can tell an engine upgrade from a native change. The fingerprint stays the same.`,
          commands: [FINGERPRINT_CREATE],
          paths: ["fingerprint.json"],
        });
      }
      continue;
    }
    const engineChange = getFingerprintEngineChange(before, current[platform]);
    if (engineChange) {
      issues.push({
        type: "error",
        platform,
        code: "FINGERPRINT_ENGINE_CHANGED",
        ...describeFingerprintEngineChange(engineChange, label),
        // Going back to the engine or rebuilding shipped apps is the user's
        // call, so no command is offered to run.
        paths: ["fingerprint.json"],
      });
      continue;
    }
    let changes: NativeCheckIssue["changes"];
    if (before?.sources) {
      try {
        changes = summarizeFingerprintDiff(
          await getFingerprintDiff(before, {
            platform,
            ...(await ensureFingerprintConfig()),
          }),
        );
      } catch {
        // The hash comparison stands without the list of changed sources.
      }
    }
    issues.push({
      type: "error",
      platform,
      code: "FINGERPRINT_JSON_STALE",
      message: before?.hash
        ? `The ${label} fingerprint changed since fingerprint.json was created.`
        : `fingerprint.json has no ${label} fingerprint.`,
      resolution: `Run \`${FINGERPRINT_CREATE}\`, then rebuild the ${label} app.`,
      commands: [FINGERPRINT_CREATE],
      paths: ["fingerprint.json"],
      ...(changes === undefined ? {} : { changes }),
    });
  }
  return issues;
};

/**
 * FINGERPRINT_JSON_UNUSED when fingerprint.json is left in a project whose
 * update strategy is not `fingerprint`: native builds embed its hash, and an
 * app with a fingerprint hash reports the fingerprint strategy.
 */
export const checkUnusedFingerprintJson = (
  cwd: string,
  updateStrategy: string,
): NativeCheckIssue[] =>
  updateStrategy !== "fingerprint" &&
  fs.existsSync(path.join(cwd, "fingerprint.json"))
    ? [
        {
          type: "error",
          platform: "project",
          code: "FINGERPRINT_JSON_UNUSED",
          message: `fingerprint.json exists, but updateStrategy is '${updateStrategy}'. Native builds embed its fingerprint hash, so the app reports the fingerprint strategy.`,
          resolution:
            "Delete fingerprint.json, then rebuild the app. To use the fingerprint strategy instead, set updateStrategy to 'fingerprint' in hot-updater.config.ts.",
          paths: ["fingerprint.json"],
        },
      ]
    : [];
