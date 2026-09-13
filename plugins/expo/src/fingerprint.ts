import fs from "node:fs";
import path from "node:path";

import { createFingerprintAsync, SourceSkips } from "@expo/fingerprint";
import type {
  FingerprintExtraSources,
  NativeFingerprint,
  NativeFingerprintOptions,
} from "@hot-updater/plugin-core";
import fg from "fast-glob";

const resolveExtraSources = (
  sources: FingerprintExtraSources | undefined,
  platform: "ios" | "android",
) => (Array.isArray(sources) ? sources : (sources?.[platform] ?? []));

type ExpoExtraSource =
  | { type: "dir"; filePath: string; reasons: string[] }
  | {
      type: "contents";
      id: string;
      contents: Buffer;
      reasons: string[];
    };

const processExtraSources = (patterns: string[], cwd: string) => {
  const sources: ExpoExtraSource[] = [];
  for (const pattern of patterns) {
    for (const absolutePath of fg.globSync(pattern, {
      cwd,
      absolute: true,
      onlyFiles: false,
    })) {
      const stat = fs.statSync(absolutePath);
      const relativePath = path.relative(cwd, absolutePath);
      sources.push(
        stat.isDirectory()
          ? {
              type: "dir",
              filePath: relativePath,
              reasons: ["custom-user-config"],
            }
          : {
              type: "contents",
              id: relativePath,
              contents: fs.readFileSync(absolutePath),
              reasons: ["custom-user-config"],
            },
      );
    }
  }
  return sources;
};

const allowExtensions = (extensions: string[]) =>
  extensions.map((extension) => `!**/${extension}`);

export async function createExpoFingerprint(
  cwd: string,
  options: NativeFingerprintOptions,
): Promise<NativeFingerprint> {
  return createFingerprintAsync(cwd, {
    useRNCoreAutolinkingFromExpo: true,
    platforms: [options.platform],
    ignorePaths: [
      "**/*",
      "**/.build/**/*",
      "**/build/",
      "**/build*/**/*",
      ...allowExtensions([
        "*.swift",
        "*.h",
        "*.m",
        "*.mm",
        "*.kt",
        "*.java",
        "*.cpp",
        "*.hpp",
        "*.c",
        "*.cc",
        "*.cxx",
        "*.podspec",
        "*.gradle",
        "*.kts",
        "CMakeLists.txt",
        "Android.mk",
        "Application.mk",
        "*.pro",
        "*.mk",
        "*.cmake",
        "*.ninja",
        "Makefile",
        "*.bazel",
        "*.buck",
        "BUILD",
        "WORKSPACE",
        "BUILD.bazel",
        "WORKSPACE.bazel",
      ]),
      "android/**/*",
      "ios/**/*",
      ...(options.ignorePaths ?? []),
    ],
    sourceSkips:
      SourceSkips.GitIgnore |
      SourceSkips.PackageJsonScriptsAll |
      SourceSkips.PackageJsonAndroidAndIosScriptsIfNotContainRun |
      SourceSkips.ExpoConfigAll |
      SourceSkips.ExpoConfigVersions |
      SourceSkips.ExpoConfigNames |
      SourceSkips.ExpoConfigRuntimeVersionIfString |
      SourceSkips.ExpoConfigAssets |
      SourceSkips.ExpoConfigExtraSection |
      SourceSkips.ExpoConfigEASProject |
      SourceSkips.ExpoConfigSchemes,
    extraSources: processExtraSources(
      resolveExtraSources(options.extraSources, options.platform),
      cwd,
    ),
    debug: options.debug,
  });
}
