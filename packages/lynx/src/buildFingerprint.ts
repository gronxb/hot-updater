import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

const PLATFORM_NATIVE_INPUTS = {
  android: [
    "android/**/src/main/**/*",
    "android/**/build.gradle",
    "android/**/build.gradle.kts",
    "android/**/*.pro",
    "android/gradle.properties",
    "android/gradle/libs.versions.toml",
    "android/gradle/wrapper/gradle-wrapper.properties",
    "android/settings.gradle",
    "android/settings.gradle.kts",
  ],
  ios: [
    "ios/**/*.c",
    "ios/**/*.cc",
    "ios/**/*.cpp",
    "ios/**/*.entitlements",
    "ios/**/*.h",
    "ios/**/*.m",
    "ios/**/*.mm",
    "ios/**/*.modulemap",
    "ios/**/*.pdf",
    "ios/**/*.plist",
    "ios/**/*.png",
    "ios/**/*.strings",
    "ios/**/*.stringsdict",
    "ios/**/*.storyboard",
    "ios/**/*.swift",
    "ios/**/*.xcassets/**/*",
    "ios/**/*.xcconfig",
    "ios/**/*.xcprivacy",
    "ios/**/*.xcodeproj/project.pbxproj",
    "ios/**/*.xcscheme",
    "ios/**/*.xcworkspace/contents.xcworkspacedata",
    "ios/**/*.xib",
    "ios/Package.resolved",
    "ios/Package.swift",
    "ios/Podfile",
    "ios/Podfile.lock",
  ],
} as const;

const PACKAGE_NATIVE_INPUTS = {
  android: [
    "android/build.gradle",
    "android/libs/*.jar",
    "android/src/main/**/*",
    "android-sparkling/build.gradle",
    "android-sparkling/src/main/**/*",
    "package.json",
  ],
  ios: [
    "ios/*.podspec",
    "ios/Package.swift",
    "ios/Sources/HotUpdaterLynxArtifact/**/*",
    "ios/Sources/HotUpdaterLynxBsdiff/**/*",
    "ios/Sources/HotUpdaterLynxSparkling/**/*",
    "ios/Sources/HotUpdaterLynxSparklingCore/**/*",
    "package.json",
  ],
} as const;

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

const FINGERPRINT_PLACEHOLDER = "__HOT_UPDATER_FINGERPRINT_HASH__";

const normalizeInjectedFingerprint = (filePath: string, bytes: Buffer) => {
  const source = bytes.toString("utf8");
  if (
    filePath.startsWith("android/") &&
    filePath.endsWith("AndroidManifest.xml")
  ) {
    return Buffer.from(
      source.replace(/<meta-data\b[^>]*>/gs, (element) => {
        if (
          !/\bandroid:name\s*=\s*(["'])com\.hotupdater\.FINGERPRINT_HASH\1/.test(
            element,
          )
        ) {
          return element;
        }
        return element.replace(
          /(\bandroid:value\s*=\s*)(["'])[^"']*\2/,
          `$1$2${FINGERPRINT_PLACEHOLDER}$2`,
        );
      }),
    );
  }
  if (filePath.startsWith("ios/") && filePath.endsWith(".plist")) {
    return Buffer.from(
      source.replace(
        /(<key>\s*HOT_UPDATER_FINGERPRINT_HASH\s*<\/key>\s*<string>)[\s\S]*?(<\/string>)/g,
        `$1${FINGERPRINT_PLACEHOLDER}$2`,
      ),
    );
  }
  return bytes;
};

const hashLynxFingerprintSource = async (
  source: Awaited<ReturnType<typeof resolveFingerprintSourcePaths>>[number],
) => {
  const initial = await hashFingerprintSourcePath(source);
  if (
    source.type !== "file" ||
    source.symbolicLinkTarget !== undefined ||
    (!source.filePath.endsWith("AndroidManifest.xml") &&
      !source.filePath.endsWith(".plist"))
  ) {
    return initial;
  }
  const bytes = await fs.readFile(source.absolutePath);
  const final = await hashFingerprintSourcePath(source);
  if (initial.hash !== final.hash || initial.byteSize !== final.byteSize) {
    throw new Error(`Fingerprint source changed: ${source.filePath}`);
  }
  return {
    byteSize: initial.byteSize,
    hash: createHash("sha256")
      .update(normalizeInjectedFingerprint(source.filePath, bytes))
      .digest("hex"),
  };
};

const resolveExtraPatterns = (
  extraSources: NativeFingerprintOptions["extraSources"],
  platform: "ios" | "android",
) =>
  Array.isArray(extraSources) ? extraSources : (extraSources?.[platform] ?? []);

export async function createLynxNativeFingerprint(
  cwd: string,
  options: NativeFingerprintOptions,
  packageRoot = PACKAGE_ROOT,
): Promise<NativeFingerprint> {
  const [nativePaths, packagePaths, extraPaths] = await Promise.all([
    resolveFingerprintSourcePaths({
      cwd,
      ignore: [...GENERATED_PATHS, ...(options.ignorePaths ?? [])],
      patterns: [
        ...PLATFORM_NATIVE_INPUTS[options.platform],
        ...ROOT_NATIVE_INPUTS,
      ],
    }),
    resolveFingerprintSourcePaths({
      cwd: packageRoot,
      ignore: GENERATED_PATHS,
      patterns: PACKAGE_NATIVE_INPUTS[options.platform],
    }).then((sources) =>
      sources.map((source) => ({
        ...source,
        filePath: `@hot-updater/lynx/${source.filePath}`,
      })),
    ),
    resolveFingerprintSourcePaths({
      cwd,
      followSymbolicLinks: true,
      includeDirectories: true,
      patterns: resolveExtraPatterns(options.extraSources, options.platform),
    }),
  ]);
  const paths = new Map(
    [...nativePaths, ...packagePaths, ...extraPaths].map((source) => [
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
        const { byteSize, hash } = await hashLynxFingerprintSource(source);
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
