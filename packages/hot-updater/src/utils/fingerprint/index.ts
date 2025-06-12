import fs from "fs";
import path from "path";
import * as p from "@clack/prompts";
import type {
  FileHookTransformSource,
  FingerprintSource,
} from "@expo/fingerprint";
import { createFingerprintAsync } from "@expo/fingerprint";
import { getCwd, loadConfig } from "@hot-updater/plugin-core";
import { processExtraSources } from "./processExtraSources";

export type FingerprintSources = {
  extraSources: string[];
  ignorePaths: string[];
};

export type FingerprintOptions = {
  platform: "ios" | "android";
  extraSources: string[];
  ignorePaths: string[];
};

export type FingerprintResult = {
  hash: string;
  sources: FingerprintSource[];
};

function removeHotUpdaterFieldsFromStringsXml(contents: string): string {
  return contents
    .replaceAll(
      /<string name="hot_updater_fingerprint_hash" moduleConfig="true">[^<]+<\/string>/g,
      "",
    )
    .replaceAll(
      /<string name="hot_updater_channel" moduleConfig="true">[^<]+<\/string>/g,
      "",
    );
}

function removeHotUpdaterFieldsFromInfoPlist(contents: string): string {
  return contents
    .replaceAll(
      /<key>HOT_UPDATER_FINGERPRINT_HASH<\/key>\s*<string>[^<]+<\/string>/g,
      "",
    )
    .replaceAll(
      /<key>HOT_UPDATER_CHANNEL<\/key>\s*<string>[^<]+<\/string>/g,
      "",
    );
}

function removeHotUpdaterChannelFromAppJson(contents: string): string {
  try {
    const appConfig = JSON.parse(contents);

    if (appConfig.plugins && Array.isArray(appConfig.plugins)) {
      appConfig.plugins = appConfig.plugins.map((plugin: any) => {
        if (
          Array.isArray(plugin) &&
          plugin[0] === "@hot-updater/react-native"
        ) {
          if (plugin[1] && typeof plugin[1] === "object") {
            const { channel, ...restConfig } = plugin[1];
            return [plugin[0], restConfig];
          }
        }
        return plugin;
      });
    }

    return JSON.stringify(appConfig, null, 2);
  } catch (error) {
    return contents;
  }
}

function removeHotUpdaterChannelFromAppConfigJs(contents: string): string {
  return contents.replace(
    /(\[\s*["']@hot-updater\/react-native["']\s*,\s*\{\s*)([^}]*?)(\s*\}\s*\])/gs,
    (_, start, middle, end) => {
      // channel 속성을 제거
      const cleanedMiddle = middle
        .replace(/["']?channel["']?\s*:\s*["'][^"']*["']\s*,?\s*/g, "")
        .replace(/,\s*$/, ""); // 마지막 쉼표 제거
      return `${start}${cleanedMiddle}${end}`;
    },
  );
}

function fileHookTransform(
  source: FileHookTransformSource,
  chunk: Buffer<ArrayBufferLike> | string | null,
): Buffer<ArrayBufferLike> | string | null {
  if (source.type !== "file" || !chunk) {
    return chunk;
  }

  const chunkString = chunk.toString("utf-8");
  const fileName = path.basename(source.filePath);

  if (source.filePath.endsWith(".xml")) {
    return Buffer.from(removeHotUpdaterFieldsFromStringsXml(chunkString));
  }

  if (source.filePath.endsWith(".plist")) {
    return Buffer.from(removeHotUpdaterFieldsFromInfoPlist(chunkString));
  }

  if (fileName === "app.json") {
    return Buffer.from(removeHotUpdaterChannelFromAppJson(chunkString));
  }

  if (fileName.startsWith("app.config.")) {
    return Buffer.from(removeHotUpdaterChannelFromAppConfigJs(chunkString));
  }

  return chunk;
}

/**
 * Calculates the fingerprint of the native parts project of the project.
 */
export async function nativeFingerprint(
  path: string,
  options: FingerprintOptions,
): Promise<FingerprintResult> {
  const platform = options.platform;
  return createFingerprintAsync(path, {
    platforms: [platform],
    ignorePaths: options.ignorePaths,
    fileHookTransform,
    extraSources: processExtraSources(
      options.extraSources,
      path,
      options.ignorePaths,
    ),
  });
}

const ensureFingerprintConfig = async () => {
  const config = await loadConfig(null);
  if (config.updateStrategy === "appVersion") {
    p.log.error(
      "The updateStrategy in hot-updater.config.ts is set to 'appVersion'. This command only works with 'fingerprint' strategy.",
    );
    process.exit(1);
  }
  return config.fingerprint;
};

export const generateFingerprints = async () => {
  const fingerprintConfig = await ensureFingerprintConfig();

  const [ios, android] = await Promise.all([
    nativeFingerprint(getCwd(), {
      platform: "ios",
      ...fingerprintConfig,
    }),
    nativeFingerprint(getCwd(), {
      platform: "android",
      ...fingerprintConfig,
    }),
  ]);
  return { ios, android };
};

export const generateFingerprint = async (platform: "ios" | "android") => {
  const fingerprintConfig = await ensureFingerprintConfig();

  return nativeFingerprint(getCwd(), {
    platform,
    ...fingerprintConfig,
  });
};

export const createFingerprintJson = async () => {
  const FINGERPRINT_FILE_PATH = path.join(getCwd(), "fingerprint.json");
  const newFingerprint = await generateFingerprints();

  await fs.promises.writeFile(
    FINGERPRINT_FILE_PATH,
    JSON.stringify(newFingerprint, null, 2),
  );

  return newFingerprint;
};

export const readLocalFingerprint = async (): Promise<{
  ios: FingerprintResult | null;
  android: FingerprintResult | null;
} | null> => {
  const FINGERPRINT_FILE_PATH = path.join(getCwd(), "fingerprint.json");
  try {
    const content = await fs.promises.readFile(FINGERPRINT_FILE_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
};
