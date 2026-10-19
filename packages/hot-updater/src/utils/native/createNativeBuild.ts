import fs from "fs";
import path from "path";

import { colors, getCwd, p } from "@hot-updater/cli-tools";
import type { BuildAdapter } from "@hot-updater/plugin-core";
import type { Platform } from "@hot-updater/protocol";

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

/** The channel an app without a default channel reports. */
const DEFAULT_CHANNEL = "production";

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
  /** The native project's default channel, for a build that reads none. */
  readChannel: () => Promise<string>;
  outputPath: string;
  buildAdapter: BuildAdapter;
  builder: () => Promise<{
    buildDirectory: string;
    buildArtifactPath: string;
    /**
     * What the built app reports at runtime, read from the artifact, which
     * an `xcconfig`, `extraParams`, flavors and build types shape.
     */
    builtApp?: { appVersion: string | null; channel: string | null };
  }>;
}): Promise<NativeBuildResult> => {
  const { buildDirectory, buildArtifactPath, builtApp } = await builder();

  // run postbuild hook
  await buildAdapter.nativeBuild?.postbuild?.({ platform });

  const artifactKind = ARTIFACT_KINDS[path.extname(buildArtifactPath)];
  if (!artifactKind) {
    throw new Error(`Unexpected native build artifact: ${buildArtifactPath}`);
  }

  const channel = builtApp
    ? (builtApp.channel ?? DEFAULT_CHANNEL)
    : await readChannel();
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
