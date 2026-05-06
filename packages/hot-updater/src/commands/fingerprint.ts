import fs from "fs";
import path from "path";

import { getCwd, loadConfig, p } from "@hot-updater/cli-tools";

import { warnIfExpoCNG } from "@/utils/expoDetection";
import {
  createAndInjectFingerprintFiles,
  type FingerprintResult,
  generateFingerprints,
  isFingerprintEquals,
  readLocalFingerprint,
} from "@/utils/fingerprint";
import {
  getFingerprintDiff,
  showFingerprintDiff,
} from "@/utils/fingerprint/diff";

import { ui } from "../utils/cli-ui";

export const handleFingerprint = async () => {
  const s = p.spinner();
  s.start("Generating fingerprints");

  const fingerPrintRef = await generateFingerprints();

  s.stop("Fingerprint generated");
  p.log.message(
    ui.block("Fingerprint", [
      ui.kv("iOS", ui.id(fingerPrintRef.ios.hash)),
      ui.kv("Android", ui.id(fingerPrintRef.android.hash)),
    ]),
  );

  const localFingerprintPath = path.join(getCwd(), "fingerprint.json");
  if (!fs.existsSync(localFingerprintPath)) {
    return;
  }

  const readFingerprint = await fs.promises.readFile(
    localFingerprintPath,
    "utf-8",
  );
  const localFingerprint = JSON.parse(readFingerprint);

  const config = await loadConfig(null);
  const fingerprintConfig = config.fingerprint;

  if (localFingerprint.ios.hash !== fingerPrintRef.ios?.hash) {
    p.log.error(
      "iOS fingerprint mismatch. Please update using 'hot-updater fingerprint create' command.",
    );

    try {
      const diff = await getFingerprintDiff(localFingerprint.ios, {
        platform: "ios",
        ...fingerprintConfig,
      });
      showFingerprintDiff(diff, "iOS");
    } catch {
      p.log.warn("Could not generate fingerprint diff");
    }

    process.exit(1);
  }

  if (localFingerprint.android.hash !== fingerPrintRef.android?.hash) {
    p.log.error(
      "Android fingerprint mismatch. Please update using 'hot-updater fingerprint create' command.",
    );

    try {
      const diff = await getFingerprintDiff(localFingerprint.android, {
        platform: "android",
        ...fingerprintConfig,
      });
      showFingerprintDiff(diff, "Android");
    } catch {
      p.log.warn("Could not generate fingerprint diff");
    }

    process.exit(1);
  }

  p.log.success("Fingerprint matched.");
};

export const handleCreateFingerprint = async () => {
  warnIfExpoCNG();
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
    if (error instanceof Error) {
      p.log.error(error.message);
    }
    console.error(error);
    process.exit(1);
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
      const config = await loadConfig(null);
      const fingerprintConfig = config.fingerprint;

      try {
        // Show iOS changes
        if (
          localFingerprint.ios &&
          localFingerprint.ios.hash !== result.fingerprint.ios.hash
        ) {
          const iosDiff = await getFingerprintDiff(localFingerprint.ios, {
            platform: "ios",
            ...fingerprintConfig,
          });
          showFingerprintDiff(iosDiff, "iOS");
        }

        // Show Android changes
        if (
          localFingerprint.android &&
          localFingerprint.android.hash !== result.fingerprint.android.hash
        ) {
          const androidDiff = await getFingerprintDiff(
            localFingerprint.android,
            {
              platform: "android",
              ...fingerprintConfig,
            },
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
