import { createHash } from "node:crypto";

import {
  compareStringsByCodeUnit,
  hashFingerprintSourcePath,
  type NativeFingerprint,
  type NativeFingerprintOptions,
  resolveFingerprintSourcePaths,
} from "@hot-updater/plugin-core";

const GENERATED_PATHS = [
  "**/{.build,.cxx,.git,.gradle,.hot-updater,build,DerivedData,node_modules,Pods}/**",
];

const ROOT_NATIVE_INPUTS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

const resolveExtraPatterns = (
  extraSources: NativeFingerprintOptions["extraSources"],
  platform: "ios" | "android",
) =>
  Array.isArray(extraSources) ? extraSources : (extraSources?.[platform] ?? []);

export async function createLynxNativeFingerprint(
  cwd: string,
  options: NativeFingerprintOptions,
): Promise<NativeFingerprint> {
  const [nativePaths, extraPaths] = await Promise.all([
    resolveFingerprintSourcePaths({
      cwd,
      ignore: [...GENERATED_PATHS, ...(options.ignorePaths ?? [])],
      patterns: [`${options.platform}/**/*`, ...ROOT_NATIVE_INPUTS],
    }),
    resolveFingerprintSourcePaths({
      cwd,
      followSymbolicLinks: true,
      includeDirectories: true,
      patterns: resolveExtraPatterns(options.extraSources, options.platform),
    }),
  ]);
  const paths = new Map(
    [...nativePaths, ...extraPaths].map((source) => [
      `${source.type}:${source.filePath}`,
      source,
    ]),
  );
  if (paths.size === 0) {
    throw new Error(
      `Lynx fingerprint found no meaningful ${options.platform} native inputs.`,
    );
  }

  const sources = await Promise.all(
    [...paths.values()]
      .sort((left, right) =>
        compareStringsByCodeUnit(left.filePath, right.filePath),
      )
      .map(async (source) => {
        const { byteSize, hash } = await hashFingerprintSourcePath(source);
        return {
          type: source.type,
          filePath: source.filePath,
          reasons: ["lynx-native-input"],
          hash,
          ...(options.debug ? { debugInfo: { byteSize } } : {}),
        };
      }),
  );
  const digest = createHash("sha256");
  for (const source of sources) {
    digest.update(source.type);
    digest.update("\0");
    digest.update(source.filePath);
    digest.update("\0");
    digest.update(source.hash);
    digest.update("\0");
  }
  return { hash: digest.digest("hex"), sources };
}
