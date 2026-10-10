import { loadConfig, p } from "@hot-updater/cli-tools";

import {
  createAndInjectFingerprintFiles,
  type FingerprintResult,
  isFingerprintEquals,
  readLocalFingerprint,
} from "@/utils/fingerprint";
import {
  getFingerprintDiff,
  showFingerprintDiff,
} from "@/utils/fingerprint/diff";

import { ui } from "../utils/cli-ui";
import { runIntegrationCommand } from "../utils/integration";

const exitWithFingerprintError = (error: unknown): never => {
  if (error instanceof Error) {
    p.log.error(error.message);
  } else {
    p.log.error(String(error));
  }

  console.error(error);
  process.exit(1);
};

export const handleCreateFingerprint = async () => {
  await runIntegrationCommand(await loadConfig(null), "fingerprint:create");
  let diffChanged = false;
  let localFingerprint: {
    ios: FingerprintResult | null;
    android: FingerprintResult | null;
  } | null = null;
  let result: {
    fingerprint: {
      android: FingerprintResult;
      ios: FingerprintResult;
    };
    androidPaths: string[];
    iosPaths: string[];
  } | null = null;

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
    if (result.androidPaths.length > 0) {
      p.log.message(
        ui.block(
          "Android paths",
          result.androidPaths.map((targetPath) =>
            ui.kv("Path", ui.path(targetPath)),
          ),
        ),
      );
    }

    if (result.iosPaths.length > 0) {
      p.log.message(
        ui.block(
          "iOS paths",
          result.iosPaths.map((targetPath) =>
            ui.kv("Path", ui.path(targetPath)),
          ),
        ),
      );
    }

    p.log.success(ui.line([ui.path("fingerprint.json"), "changed."]));
    p.log.warn("Rebuild native app.");

    // Show what changed
    if (localFingerprint && result.fingerprint) {
      try {
        // Show iOS changes
        if (
          localFingerprint.ios &&
          localFingerprint.ios.hash !== result.fingerprint.ios.hash
        ) {
          const iosDiff = getFingerprintDiff(
            localFingerprint.ios,
            result.fingerprint.ios,
          );
          showFingerprintDiff(iosDiff, "iOS");
        }

        // Show Android changes
        if (
          localFingerprint.android &&
          localFingerprint.android.hash !== result.fingerprint.android.hash
        ) {
          const androidDiff = getFingerprintDiff(
            localFingerprint.android,
            result.fingerprint.android,
          );
          showFingerprintDiff(androidDiff, "Android");
        }
      } catch {
        p.log.warn("Could not generate fingerprint diff");
      }
    }
  } else {
    p.log.success(ui.line([ui.path("fingerprint.json"), "is up to date."]));
  }
};
