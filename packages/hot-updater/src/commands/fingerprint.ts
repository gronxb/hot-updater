import fs from "node:fs";
import path from "node:path";

import {
  fitText,
  getCwd,
  p,
  withProviderMessages,
} from "@hot-updater/cli-tools";
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
import {
  getFingerprintDiff,
  showFingerprintDiff,
} from "@/utils/fingerprint/diff";

import { ui } from "../utils/cli-ui";
import { reportUnexpectedError } from "../utils/reportUnexpectedError";

const exitWithFingerprintError = (error: unknown): never => {
  reportUnexpectedError(error);
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
  // The file can change while the hashes stay the same, as when it records
  // the engine that computed them.
  const fingerprintJsonPath = path.join(getCwd(), "fingerprint.json");
  const readFingerprintJson = () =>
    fs.promises.readFile(fingerprintJsonPath, "utf8").catch(() => null);
  let fileChanged = false;

  try {
    const before = await readFingerprintJson();
    localFingerprint = await readLocalFingerprint();
    result = await createAndInjectFingerprintFiles();
    fileChanged = (await readFingerprintJson()) !== before;

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

      for (const [platform, label] of [
        ["ios", "iOS"],
        ["android", "Android"],
      ] as const) {
        const before = localFingerprint[platform];
        const after = result.fingerprint[platform];
        if (!before || before.hash === after.hash) continue;
        const engineChange = getFingerprintEngineChange(before, after);
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
            await getFingerprintDiff(before, {
              platform,
              ...fingerprintConfig,
            }),
            label,
          );
        } catch {
          p.log.warn(`Could not generate the ${label} fingerprint diff`);
        }
      }
    }
  } else if (fileChanged) {
    p.log.success(
      ui.line([
        ui.path("fingerprint.json"),
        "updated. The fingerprint is unchanged, so builds you shipped keep receiving updates.",
      ]),
    );
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
