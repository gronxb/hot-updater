import crypto from "node:crypto";
import path from "node:path";
import type { FingerprintSource, HashSource } from "@expo/fingerprint";
import { createFingerprintAsync } from "@expo/fingerprint";
import { processExtraSources } from "./processExtraSources";

const HASH_ALGORITHM = "sha1";
const EXCLUDED_SOURCES = [
  "expoAutolinkingConfig:ios",
  "expoAutolinkingConfig:android",
];

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
    dirExcludes: [
      "android/build",
      "android/**/build",
      "android/**/.cxx",
      "ios/DerivedData",
      "ios/Pods",
      "node_modules",
      "android/local.properties",
      "android/.idea",
      "android/.gradle",
    ],
    extraSources: [
      ...processExtraSources(options.extraSources, path, options.ignorePaths),
    ],
    ignorePaths: options.ignorePaths,
  });

  // Filter out un-relevant sources as these caused hash mismatch between local and remote builds
  const sources = fingerprint.sources.filter((source) =>
    "id" in source ? !EXCLUDED_SOURCES.includes(source.id) : true,
  );

  const hash = await hashSources(sources);

  return { hash, sources };
}

async function hashSources(sources: FingerprintSource[]) {
  let input = "";
  for (const source of sources) {
    if (source.hash != null) {
      input += `${createSourceId(source)}-${source.hash}\n`;
    }
  }
  const hasher = crypto.createHash(HASH_ALGORITHM);
  hasher.update(input);
  return hasher.digest("hex");
}

function createSourceId(source: FingerprintSource) {
  switch (source.type) {
    case "contents":
      return source.id;
    case "file":
      return source.filePath;
    case "dir":
      return source.filePath;
    default:
      // @ts-expect-error: we intentionally want to detect invalid types
      throw new RnefError(`Unsupported source type: ${source.type}`);
  }
}

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function parseAutolinkingSources({
  config,
  reasons,
  contentsId,
}: {
  config: any;
  reasons: string[];
  contentsId: string;
}): HashSource[] {
  const results: HashSource[] = [];
  const { root } = config;
  const autolinkingConfig: Record<string, any> = {};
  for (const [depName, depData] of Object.entries<any>(config.dependencies)) {
    try {
      stripAutolinkingAbsolutePaths(depData, root);
      const filePath = toPosixPath(depData.root);
      results.push({ type: "dir", filePath, reasons });

      autolinkingConfig[depName] = depData;
    } catch (e) {
      console.warn(
        `Error adding react-native core autolinking - ${depName}.\n${e}`,
      );
    }
  }
  results.push({
    type: "contents",
    id: contentsId,
    contents: JSON.stringify(autolinkingConfig),
    reasons,
  });
  return results;
}

function stripAutolinkingAbsolutePaths(dependency: any, root: string): void {
  const dependencyRoot = dependency.root;
  const cmakeDepRoot =
    process.platform === "win32" ? toPosixPath(dependencyRoot) : dependencyRoot;

  dependency.root = toPosixPath(path.relative(root, dependencyRoot));
  for (const platformData of Object.values<any>(dependency.platforms)) {
    for (const [key, value] of Object.entries<any>(platformData ?? {})) {
      let newValue: string | undefined;
      if (
        process.platform === "win32" &&
        ["cmakeListsPath", "cxxModuleCMakeListsPath"].includes(key)
      ) {
        // CMake paths on Windows are serving in slashes,
        // we have to check startsWith with the same slashes.
        // @todo revisit windows logic
        newValue = value?.startsWith?.(cmakeDepRoot)
          ? toPosixPath(path.relative(root, value))
          : value;
      } else {
        newValue = value?.startsWith?.(dependencyRoot)
          ? toPosixPath(path.relative(root, value))
          : value;
      }
      platformData[key] = newValue;
    }
  }
}
