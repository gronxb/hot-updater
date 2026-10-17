import { p } from "@hot-updater/cli-tools";
import type { Platform } from "@hot-updater/plugin-core";

import { warnIfExpoCNG } from "@/utils/expoDetection";
import {
  computeRecordedFingerprintHash,
  createAndInjectFingerprintFiles,
  describeFingerprintEngineChange,
  ensureFingerprintConfig,
  type FingerprintResult,
  getFingerprintEngineChange,
  isFingerprintEquals,
  readLocalFingerprint,
} from "@/utils/fingerprint";
import { isMissingFingerprintDependencyError } from "@/utils/fingerprint/dependency";
import {
  getFingerprintDiff,
  showFingerprintDiff,
} from "@/utils/fingerprint/diff";

import { ui } from "../utils/cli-ui";

const exitWithFingerprintError = (error: unknown): never => {
  if (error instanceof Error) {
    p.log.error(error.message);
  } else {
    p.log.error(String(error));
  }

  if (!isMissingFingerprintDependencyError(error)) {
    console.error(error);
  }
  process.exit(1);
};

export const handleCreateFingerprint = async () => {
  warnIfExpoCNG();
  let diffChanged = false;
  let localFingerprint: {
    ios: FingerprintResult | null;
    android: FingerprintResult | null;
  } | null = null;
  let result: Awaited<
    ReturnType<typeof createAndInjectFingerprintFiles>
  > | null = null;

  const s = p.spinner();
  s.start("Creating fingerprint.json");

  try {
    localFingerprint = await readLocalFingerprint();
    result = await createAndInjectFingerprintFiles();

    if (!isFingerprintEquals(localFingerprint, result.fingerprint)) {
      diffChanged = true;
    }
    s.stop("Created fingerprint.json");
  } catch (error) {
    s.error("Creating fingerprint.json failed");
    exitWithFingerprintError(error);
  }

  if (diffChanged && result) {
    p.log.success(ui.line([ui.path("fingerprint.json"), "changed."]));
    p.log.warn("Rebuild the native app to embed the new fingerprint.");

    // Show what changed
    if (localFingerprint && result.fingerprint) {
      const fingerprintConfig = await ensureFingerprintConfig();

      try {
        for (const [platform, label] of [
          ["ios", "iOS"],
          ["android", "Android"],
        ] as const) {
          const before = localFingerprint[platform];
          const after = result.fingerprint[platform];
          if (!before || before.hash === after.hash) continue;
          const engineChange = getFingerprintEngineChange(before, after);
          if (engineChange) {
            p.log.warn(
              describeFingerprintEngineChange(engineChange, label).message,
            );
            continue;
          }
          showFingerprintDiff(
            await getFingerprintDiff(before, {
              platform,
              ...fingerprintConfig,
            }),
            label,
          );
        }
      } catch {
        p.log.warn("Could not generate fingerprint diff");
      }
    }
  } else {
    p.log.success(ui.line([ui.path("fingerprint.json"), "is up to date."]));
  }
};

/**
 * Prints the fingerprint a native build of `platform` embeds: the hash of the
 * project's native interface, computed from the inputs fingerprint.json
 * records, so it needs no deploy secrets. Native builds run it; CI can run it
 * to see the fingerprint a build will have. Writes nothing.
 */
export const handleFingerprintHash = async ({
  platform,
}: {
  platform: Platform;
}) => {
  try {
    const { hash, recorded } = await computeRecordedFingerprintHash(platform);
    if (recorded !== null && recorded !== hash) {
      console.error(
        `warning: fingerprint.json is stale for ${platform}: it records ${recorded} and the project now hashes to ${hash}. The build embeds ${hash}; run \`npx hot-updater fingerprint create\` before deploying.`,
      );
    }
    console.log(hash);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};
