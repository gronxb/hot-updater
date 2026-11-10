import fs from "node:fs";
import path from "node:path";

import {
  fitText,
  getCwd,
  p,
  withProviderMessages,
} from "@hot-updater/cli-tools";
import type { Platform } from "@hot-updater/plugin-core";

import {
  computeRecordedFingerprintHash,
  createAndInjectFingerprintFiles,
  describeFingerprintEngineChange,
  ensureFingerprintConfig,
  getFingerprintEngineChange,
  isFingerprintEquals,
  readLocalFingerprint,
} from "@/utils/fingerprint";
import {
  getFingerprintDiff,
  showFingerprintDiff,
} from "@/utils/fingerprint/diff";
import { warnIfPrebuildGenerated } from "@/utils/prebuildDetection";

import { ui } from "../utils/cli-ui";
import { reportUnexpectedError } from "../utils/reportUnexpectedError";
import { FINGERPRINT_JSON_COMMIT_HINT } from "./initFingerprint";

const exitWithFingerprintError = (error: unknown): never => {
  reportUnexpectedError(error);
  process.exit(1);
};

export const handleCreateFingerprint = async () => {
  await warnIfPrebuildGenerated();
  let result: Awaited<
    ReturnType<typeof createAndInjectFingerprintFiles>
  > | null = null;

  const s = p.spinner();
  s.start("Creating fingerprint.json");
  const cwd = getCwd();
  let before: string | null = null;
  let localFingerprint: Awaited<ReturnType<typeof readLocalFingerprint>> = null;

  try {
    before = await fs.promises
      .readFile(path.join(cwd, "fingerprint.json"), "utf8")
      .catch(() => null);
    localFingerprint = await readLocalFingerprint();
    result = await createAndInjectFingerprintFiles();
  } catch (error) {
    s.error("Creating fingerprint.json failed");
    exitWithFingerprintError(error);
  }
  if (!result) return;

  if (before === null) {
    s.stop("Created fingerprint.json");
    // A first fingerprint.json changes nothing a build embedded.
    p.log.info(FINGERPRINT_JSON_COMMIT_HINT);
    return;
  }
  if (!result.written) {
    s.stop(ui.line([ui.path("fingerprint.json"), "is up to date."]));
    return;
  }

  // An unreadable file, as a merge conflict leaves, has no fingerprint to
  // compare with.
  const previous = localFingerprint;
  if (!previous) {
    s.stop("Rewrote fingerprint.json, which wasn't valid JSON.");
    return;
  }
  if (isFingerprintEquals(previous, result.fingerprint)) {
    s.stop(
      ui.line([
        ui.path("fingerprint.json"),
        "updated. The fingerprint is unchanged, so builds you shipped keep receiving updates.",
      ]),
    );
    return;
  }

  s.stop(ui.line([ui.path("fingerprint.json"), "changed."]));
  p.log.warn("Rebuild the native app to embed the new fingerprint.");

  // Show what changed
  const fingerprintConfig = await ensureFingerprintConfig();
  for (const [platform, label] of [
    ["ios", "iOS"],
    ["android", "Android"],
  ] as const) {
    const previousPlatform = previous[platform];
    const after = result.fingerprint[platform];
    if (!previousPlatform || previousPlatform.hash === after.hash) continue;
    const engineChange = getFingerprintEngineChange(previousPlatform, after);
    if (engineChange) {
      const { message, resolution } = describeFingerprintEngineChange(
        engineChange,
        label,
        true,
      );
      p.log.warn(message);
      p.log.info(resolution);
      continue;
    }
    try {
      showFingerprintDiff(
        await getFingerprintDiff(previousPlatform, {
          platform,
          ...fingerprintConfig,
        }),
        label,
      );
    } catch {
      p.log.warn(`Could not generate the ${label} fingerprint diff`);
    }
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
        fitText(
          `warning: fingerprint.json is stale for ${platform}: it records ${recorded} and the project now hashes to ${hash}. The build embeds ${hash}; run \`npx hot-updater fingerprint create\` before deploying.`,
        ),
      );
    }
    console.log(hash);
  } catch (error) {
    console.error(
      fitText(
        withProviderMessages(
          error instanceof Error ? error.message : String(error),
        ),
      ),
    );
    process.exit(1);
  }
};
