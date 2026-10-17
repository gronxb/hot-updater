import fs from "node:fs";
import path from "node:path";

import { getCwd, p } from "@hot-updater/cli-tools";

import { warnIfExpoCNG } from "@/utils/expoDetection";
import {
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
