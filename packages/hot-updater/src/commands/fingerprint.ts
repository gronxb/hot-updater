import fs from "fs";
import path from "path";
import {
  type FingerprintResult,
  generateFingerprints,
} from "@/utils/fingerprint";
import { setFingerprintHash } from "@/utils/setFingerprintHash";
import * as p from "@clack/prompts";
import { getCwd } from "@hot-updater/plugin-core";
import picocolors from "picocolors";

export const handleFingerprint = async () => {
  const s = p.spinner();
  s.start("Generating fingerprints");

  const fingerPrintRef = await generateFingerprints();

  s.stop(
    `Fingerprint generated. iOS: ${fingerPrintRef.ios.hash}, Android: ${fingerPrintRef.android.hash}`,
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
  if (localFingerprint.ios.hash !== fingerPrintRef.ios?.hash) {
    p.log.error(
      "iOS fingerprint mismatch. Please update using 'hot-updater fingerprint create' command.",
    );
    process.exit(1);
  }

  if (localFingerprint.android.hash !== fingerPrintRef.android?.hash) {
    p.log.error(
      "Android fingerprint mismatch. Please update using 'hot-updater fingerprint create' command.",
    );
    process.exit(1);
  }

  p.log.success("Fingerprint matched");
};

export const handleCreateFingerprint = async () => {
  const FINGERPRINT_FILE_PATH = path.join(getCwd(), "fingerprint.json");

  const readLocalFingerprint = async (): Promise<{
    ios: FingerprintResult | null;
    android: FingerprintResult | null;
  } | null> => {
    try {
      const content = await fs.promises.readFile(
        FINGERPRINT_FILE_PATH,
        "utf-8",
      );
      return JSON.parse(content);
    } catch {
      return null;
    }
  };

  let diffChanged = false;
  await p.tasks([
    {
      title: "Creating fingerprint.json",
      task: async () => {
        const newFingerprint = await generateFingerprints();
        const localFingerprint = await readLocalFingerprint();

        if (
          !localFingerprint ||
          localFingerprint?.ios?.hash !== newFingerprint.ios.hash ||
          localFingerprint?.android?.hash !== newFingerprint.android.hash
        ) {
          diffChanged = true;
        }

        await fs.promises.writeFile(
          FINGERPRINT_FILE_PATH,
          JSON.stringify(newFingerprint, null, 2),
        );
        await setFingerprintHash("ios", newFingerprint.ios.hash);
        await setFingerprintHash("android", newFingerprint.android.hash);
        return "Created fingerprint.json";
      },
    },
  ]);

  if (diffChanged) {
    p.log.success(
      picocolors.bold(
        `${picocolors.blue("fingerprint.json")} has changed, you need to rebuild the native app.`,
      ),
    );
  } else {
    p.log.success(
      picocolors.bold(`${picocolors.blue("fingerprint.json")} is up to date.`),
    );
  }
};
