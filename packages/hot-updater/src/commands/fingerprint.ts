import fs from "fs";
import path from "path";
import {
  createAndInjectFingerprintFiles,
  generateFingerprints,
  isFingerprintEquals,
  readLocalFingerprint,
} from "@/utils/fingerprint";
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
  let diffChanged = false;

  await p.tasks([
    {
      title: "Creating fingerprint.json",
      task: async () => {
        try {
          const localFingerprint = await readLocalFingerprint();
          const newFingerprint = await createAndInjectFingerprintFiles();

          if (!isFingerprintEquals(localFingerprint, newFingerprint)) {
            diffChanged = true;
          }
          return "Created fingerprint.json";
        } catch (error) {
          if (error instanceof Error) {
            p.log.error(error.message);
          }
          console.error(error);
          process.exit(1);
        }
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
