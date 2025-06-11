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

function fileHookTransform(
  source: FileHookTransformSource,
  chunk: Buffer<ArrayBufferLike> | string | null,
): Buffer<ArrayBufferLike> | string | null {
  if (source.type !== "file" || !chunk) {
    return chunk;
  }

  const chunkString = chunk.toString("utf-8");

  if (source.filePath.endsWith(".xml")) {
    return Buffer.from(removeHotUpdaterFieldsFromStringsXml(chunkString));
  }

  if (source.filePath.endsWith(".plist")) {
    return Buffer.from(removeHotUpdaterFieldsFromInfoPlist(chunkString));
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
