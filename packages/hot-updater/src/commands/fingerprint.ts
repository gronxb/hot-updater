import fs from "fs";
import path from "path";
import { type FingerprintResult, nativeFingerprint } from "@/utils/fingerprint";
import { setFingerprintHash } from "@/utils/setFingerprintHash";
import * as p from "@clack/prompts";
import {
  type ConfigResponse,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";
import picocolors from "picocolors";

export const handleFingerprint = async () => {
  const config = await loadConfig(null);
  if (config.updateStrategy === "appVersion") {
    p.log.error(
      "The updateStrategy in hot-updater.config.ts is set to 'appVersion'. This command only works with 'fingerprint' strategy.",
    );
    process.exit(1);
  }

  const fingerPrintRef = {
    ios: null as FingerprintResult | null,
    android: null as FingerprintResult | null,
  };
  await p.tasks([
    {
      title: "Generating fingerprint (iOS)",
      task: async () => {
        const fingerprint = await nativeFingerprint(getCwd(), {
          platform: "ios",
          ...config.fingerprint,
        });
        fingerPrintRef.ios = fingerprint;
        return `Fingerprint(iOS): ${fingerprint.hash}`;
      },
    },
    {
      title: "Generating fingerprint (Android)",
      task: async () => {
        const fingerprint = await nativeFingerprint(getCwd(), {
          platform: "android",
          ...config.fingerprint,
        });
        fingerPrintRef.android = fingerprint;
        return `Fingerprint(Android): ${fingerprint.hash}`;
      },
    },
  ]);

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

  const createFingerprintData = async (config: ConfigResponse) => {
    const [ios, android] = await Promise.all([
      nativeFingerprint(getCwd(), {
        platform: "ios",
        ...config.fingerprint,
      }),
      nativeFingerprint(getCwd(), {
        platform: "android",
        ...config.fingerprint,
      }),
    ]);
    return { ios, android };
  };

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
        const config = await loadConfig(null);
        if (config.updateStrategy === "appVersion") {
          p.log.error(
            "The updateStrategy in hot-updater.config.ts is set to 'appVersion'. This command only works with 'fingerprint' strategy.",
          );
          process.exit(1);
        }

        const newFingerprint = await createFingerprintData(config);
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
