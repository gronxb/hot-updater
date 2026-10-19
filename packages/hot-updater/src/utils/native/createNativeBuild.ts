import fs from "fs";
import path from "path";

import { colors, getCwd, p } from "@hot-updater/cli-tools";
import type { BuildAdapter } from "@hot-updater/plugin-core";
import type { Platform } from "@hot-updater/protocol";

import { parsePlist } from "../configParser/plistUtils";

/** The kinds of artifact `build:android` and `build:ios` produce. */
export type NativeBuildArtifactKind = "apk" | "aab" | "ipa" | "app";

/**
 * What a native build compiled in, whichever of `fingerprintHash` and
 * `appVersion` the update strategy selects by.
 */
export type NativeBuildTarget =
  | { fingerprintHash: string; appVersion: null }
  | { fingerprintHash: null; appVersion: string };

/**
 * What `build:android` and `build:ios` built: the artifact under the output
 * path, and the values compiled into it that select its updates.
 */
export type NativeBuildResult = NativeBuildTarget & {
  platform: Platform;
  /** The `nativeBuild` scheme built. */
  scheme: string;
  /** The MIN_BUNDLE_ID compiled in, the ID of the built-in bundle. */
  minBundleId: string;
  /** The default channel compiled in. */
  channel: string;
  artifactPath: string;
  artifactKind: NativeBuildArtifactKind;
};

const ARTIFACT_KINDS: Record<string, NativeBuildArtifactKind> = {
  ".apk": "apk",
  ".aab": "aab",
  ".ipa": "ipa",
  ".app": "app",
};

/**
 * The values an iOS app reports at runtime, read from the built app's
 * Info.plist, so build settings an `xcconfig` or `extraParams` override are
 * the ones reported.
 */
const readBuiltAppInfo = async (appPath: string) => {
  const infoPlist = parsePlist(
    await fs.promises.readFile(path.join(appPath, "Info.plist")),
  );
  const read = (key: string) =>
    typeof infoPlist[key] === "string" && infoPlist[key]
      ? infoPlist[key]
      : null;
  return {
    appVersion: read("CFBundleShortVersionString"),
    channel: read("HOT_UPDATER_CHANNEL"),
  };
};

/**
 * Runs the build and the adapter's postbuild, then copies the output to
 * `outputPath`. The adapter's prebuild has already run, in
 * `prepareNativeBuild`.
 */
export const createNativeBuild = async ({
  platform,
  scheme,
  minBundleId,
  target,
  readChannel,
  outputPath,
  buildAdapter,
  builder,
}: {
  platform: Platform;
  scheme: string;
  minBundleId: string;
  target: NativeBuildTarget;
  /** The default channel in the native project, for a build without one. */
  readChannel: () => Promise<string>;
  outputPath: string;
  buildAdapter: BuildAdapter;
  builder: () => Promise<{
    buildDirectory: string;
    buildArtifactPath: string;
    /** The built `.app`, whose Info.plist holds what an iOS build reports. */
    appPath?: string;
  }>;
}): Promise<NativeBuildResult> => {
  const { buildDirectory, buildArtifactPath, appPath } = await builder();

  // run postbuild hook
  await buildAdapter.nativeBuild?.postbuild?.({ platform });

  const artifactKind = ARTIFACT_KINDS[path.extname(buildArtifactPath)];
  if (!artifactKind) {
    throw new Error(`Unexpected native build artifact: ${buildArtifactPath}`);
  }

  const builtApp = appPath ? await readBuiltAppInfo(appPath) : null;
  const channel = builtApp?.channel ?? (await readChannel());
  const builtTarget: NativeBuildTarget =
    target.appVersion !== null && builtApp?.appVersion
      ? { fingerprintHash: null, appVersion: builtApp.appVersion }
      : target;

  // copy artifacts to outputPath
  await fs.promises.mkdir(outputPath, { recursive: true });
  await fs.promises.rm(outputPath, {
    recursive: true,
    force: true,
  });
  await fs.promises.cp(buildDirectory, outputPath, {
    recursive: true,
  });

  const relativePath = path.relative(getCwd(), outputPath);
  p.log.info(`Artifact stored at ${colors.blueBright(relativePath)}`);

  return {
    platform,
    scheme,
    minBundleId,
    channel,
    ...builtTarget,
    artifactPath: path.join(
      outputPath,
      path.relative(buildDirectory, buildArtifactPath),
    ),
    artifactKind,
  };
};
