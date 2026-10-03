import {
  type FingerprintResult,
  generateFingerprints,
  getFingerprintDiff,
  summarizeFingerprintDiff,
} from "../../utils/fingerprint";
import type { NativeCheckIssue } from "./issues";

const FINGERPRINT_CREATE = "npx hot-updater fingerprint create";

const PLATFORM_LABELS = { ios: "iOS", android: "Android" } as const;

const generationFailed = (error: unknown): NativeCheckIssue => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: "error",
    platform: "project",
    code: "FINGERPRINT_GENERATION_FAILED",
    message: `Could not compute the project's fingerprint: ${message}`,
    resolution:
      "Check the fingerprint settings in hot-updater.config.ts, then rerun doctor.",
    fixability: "auto",
    paths: ["hot-updater.config.ts"],
  };
};

/**
 * Compares fingerprint.json with the project's fingerprint as
 * `fingerprint create` computes it: FINGERPRINT_JSON_STALE for each
 * platform whose hash changed, with the sources that changed.
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
    if (before?.hash === current[platform].hash) continue;
    const label = PLATFORM_LABELS[platform];
    let changes: NativeCheckIssue["changes"];
    if (before?.sources) {
      try {
        changes = summarizeFingerprintDiff(
          getFingerprintDiff(before, current[platform]),
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
      fixability: "command",
      commands: [FINGERPRINT_CREATE],
      paths: ["fingerprint.json"],
      ...(changes === undefined ? {} : { changes }),
    });
  }
  return issues;
};
