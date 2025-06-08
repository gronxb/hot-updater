import type {
  FileHookTransformSource,
  FingerprintSource,
} from "@expo/fingerprint";
import { createFingerprintAsync } from "@expo/fingerprint";
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

function removeFingerprintFromStringsXml(contents: string): string {
  return contents.replace(
    /<string name="hot_updater_fingerprint_hash" moduleConfig="true">[^<]+<\/string>/,
    "",
  );
}

function removeFingerprintFromInfoPlist(contents: string): string {
  return contents.replace(
    /<key>HOT_UPDATER_FINGERPRINT_HASH<\/key>\s*<string>[^<]+<\/string>/,
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

  if (source.filePath.endsWith("strings.xml")) {
    return Buffer.from(removeFingerprintFromStringsXml(chunkString));
  }

  if (source.filePath.endsWith("Info.plist")) {
    return Buffer.from(removeFingerprintFromInfoPlist(chunkString));
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
  const fingerprint = await createFingerprintAsync(path, {
    platforms: [platform],
    ignorePaths: options.ignorePaths,
    fileHookTransform,
    extraSources: processExtraSources(
      options.extraSources,
      path,
      options.ignorePaths,
    ),
  });

  return fingerprint;
}
