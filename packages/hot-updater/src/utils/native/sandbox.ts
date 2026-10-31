import fs from "fs";
import os from "os";
import path from "path";

import { findSandboxGradleBlocker } from "@hot-updater/android-helper";
import {
  archiveAppBundle,
  assertSandboxExportOptions,
} from "@hot-updater/apple-helper";
import { getCwd, p } from "@hot-updater/cli-tools";
import type {
  NativeBuildAndroidScheme,
  NativeBuildIosScheme,
  NativeBuildSubmissionDestination,
  Platform,
} from "@hot-updater/plugin-core";
import {
  blobSource,
  isSandboxChannel,
  type NativeArtifactInfo,
  readNativeArtifact,
  sandboxArtifactProblem,
  sandboxChannelOf,
} from "@hot-updater/protocol/native-artifact";

import {
  ensureFingerprintConfig,
  getFingerprintDiff,
  readLocalFingerprint,
  summarizeFingerprintDiff,
} from "../fingerprint";
import { getChannel } from "../setChannel";

/**
 * The stores a sandbox build may go to: the internal ones, which never reach
 * review or the public. `--submit` has no other target today; a new one stays
 * refused here until it is known to be internal.
 */
const SANDBOX_SUBMIT_TARGETS: Readonly<
  Record<Platform, readonly NativeBuildSubmissionDestination[]>
> = {
  ios: ["testflight"],
  android: ["play-internal"],
};

/** Whether an Xcode project builds with Swift Package Manager, not CocoaPods. */
export const usesSwiftPackageManager = (iosDir: string): boolean => {
  if (!fs.existsSync(iosDir)) return false;
  return fs.readdirSync(iosDir).some((name) => {
    if (!name.endsWith(".xcodeproj")) return false;
    const project = path.join(iosDir, name, "project.pbxproj");
    return (
      fs.existsSync(project) &&
      /XCLocalSwiftPackageReference\s+"build\/generated\/autolinking"/u.test(
        fs.readFileSync(project, "utf-8"),
      )
    );
  });
};

/**
 * Whether a scheme's name makes a channel the build can embed: a channel that
 * XML and a plist hold as it is.
 */
const SCHEME_NAME = /^[A-Za-z0-9._-]+$/u;

/**
 * Refuses, before any work, a sandbox scheme this build can't make, and a
 * normal scheme on a channel reserved for sandbox builds. It reads only the
 * project's files that exist, so it runs again after an adapter's prebuild
 * writes the rest.
 */
export const assertSandboxBuildAllowed = async ({
  platform,
  scheme,
  iosScheme,
  androidScheme,
  submit,
}: {
  platform: Platform;
  scheme: string;
  iosScheme?: NativeBuildIosScheme;
  androidScheme?: NativeBuildAndroidScheme;
  submit?: NativeBuildSubmissionDestination;
}): Promise<void> => {
  const schemeConfig = platform === "ios" ? iosScheme : androidScheme;
  if (!schemeConfig?.sandbox) {
    // No native project yet, as before a prebuild, has no channel to refuse.
    const native = await getChannel(platform).then(
      ({ value }) => value,
      () => undefined,
    );
    if (native !== undefined && isSandboxChannel(native)) {
      throw new Error(
        `Channel ${native} is reserved for sandbox builds, and the scheme ${scheme} isn't one.\nSet sandbox: true on it, or run:\nnpx hot-updater channel set production`,
      );
    }
    return;
  }
  const type =
    platform === "ios"
      ? iosScheme?.configuration
      : (androidScheme?.variant ?? "Release");
  if (/debug$/iu.test(type ?? "")) {
    throw new Error(
      `The sandbox scheme ${scheme} builds ${type}, which skips OTA updates.\nBuild a release configuration.`,
    );
  }
  if (!SCHEME_NAME.test(scheme)) {
    throw new Error(
      `The sandbox scheme's name ${scheme} can't name a channel.\nUse letters, digits, dots, dashes, or underscores.`,
    );
  }
  if (submit && !SANDBOX_SUBMIT_TARGETS[platform].includes(submit)) {
    throw new Error(
      `A sandbox build can't go to ${submit}.\nUse ${SANDBOX_SUBMIT_TARGETS[platform].join(" or ")}.`,
    );
  }
  if (platform === "ios") {
    if (usesSwiftPackageManager(path.join(getCwd(), "ios"))) {
      throw new Error(
        `The sandbox scheme ${scheme} builds with Swift Package Manager, which sandbox builds don't support yet.\nBuild with CocoaPods, or remove sandbox: true.`,
      );
    }
    const plist = iosScheme?.exportOptionsPlist;
    if (plist && fs.existsSync(path.resolve(getCwd(), plist))) {
      await assertSandboxExportOptions(scheme, path.resolve(getCwd(), plist));
    }
    return;
  }
  const blocker = findSandboxGradleBlocker(androidScheme ?? {});
  if (blocker) throw new Error(blocker);
};

/** Reads a built artifact: a simulator `.app` is read as its zip archive. */
export const readBuiltArtifact = async (
  artifactPath: string,
): Promise<NativeArtifactInfo> => {
  if (
    !artifactPath.endsWith(".app") ||
    !(await fs.promises.stat(artifactPath)).isDirectory()
  ) {
    return readNativeArtifact(
      blobSource(await fs.openAsBlob(artifactPath)),
      path.basename(artifactPath),
    );
  }
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-sandbox-check-"),
  );
  try {
    const zip = path.join(directory, `${path.basename(artifactPath)}.zip`);
    await archiveAppBundle({ appPath: artifactPath, outputPath: zip });
    return await readNativeArtifact(
      blobSource(await fs.openAsBlob(zip)),
      path.basename(zip),
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};

/**
 * What changed in the fingerprint's inputs since fingerprint.json, which the
 * build wrote before compiling: a user's `extraSources` over a file the build
 * writes. A line per file, or nothing when they can't be compared.
 */
const fingerprintInputsChanged = async (
  platform: Platform,
): Promise<string[]> => {
  try {
    const recorded = (await readLocalFingerprint())?.[platform];
    if (!recorded) return [];
    const { added, removed, changed } = summarizeFingerprintDiff(
      await getFingerprintDiff(recorded, {
        platform,
        ...(await ensureFingerprintConfig()),
      }),
    );
    return [...added, ...removed, ...changed];
  } catch {
    return [];
  }
};

/**
 * Refuses an artifact that isn't what its scheme asked for, before it is
 * recorded or uploaded, reading the artifact alone: a sandbox build holds the
 * sandbox layer whole, on its own channel, and embeds the fingerprint a normal
 * build would; a normal build holds none of it. A normal build that can't be
 * read warns instead: nothing about it asked for the layer.
 */
export const assertBuiltArtifact = async ({
  artifactPath,
  platform,
  scheme,
  sandbox,
  channel,
  fingerprintHash,
}: {
  artifactPath: string;
  platform: Platform;
  scheme: string;
  sandbox: boolean;
  /** The channel the build reports. */
  channel: string;
  /** The fingerprint computed before the build; null under appVersion. */
  fingerprintHash: string | null;
}): Promise<NativeArtifactInfo | null> => {
  let info: NativeArtifactInfo;
  try {
    info = await readBuiltArtifact(artifactPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (sandbox) {
      throw new Error(`Couldn't check the sandbox build.\n${reason}`, {
        cause: error,
      });
    }
    p.log.warn(`Couldn't check the build for the sandbox layer.\n${reason}`);
    return null;
  }
  // What this scheme can do about it first: the shared check only knows the
  // artifact.
  if (sandbox && !info.sandbox.code) {
    throw new Error(
      platform === "ios"
        ? `The sandbox scheme ${scheme} built without the sandbox layer.\nRun pod install, then build again.`
        : `The sandbox scheme ${scheme} built without the sandbox layer.\nUpdate @hot-updater/react-native, then build again.`,
    );
  }
  if (!sandbox && info.sandbox.code) {
    throw new Error(
      platform === "ios"
        ? `The scheme ${scheme} isn't a sandbox scheme, but its build holds the sandbox layer.\nRemove INCLUDED_SOURCE_FILE_NAMES from the project's build settings.`
        : `The scheme ${scheme} isn't a sandbox scheme, but its build holds the sandbox layer.\nRemove hotUpdaterSandbox from gradle.properties.`,
    );
  }
  const problem = sandboxArtifactProblem(info, channel);
  if (problem) throw new Error(problem.message);
  if (sandbox) {
    const expected = sandboxChannelOf(scheme);
    if (channel !== expected) {
      throw new Error(
        `The sandbox scheme ${scheme} built channel ${channel}, not ${expected}.\nRemove the channel its build type or flavor sets.`,
      );
    }
    // Any other SHA-256 literal in the app, such as a library's, is no matter.
    if (
      fingerprintHash !== null &&
      !info.fingerprintCandidates.includes(fingerprintHash)
    ) {
      const changed = await fingerprintInputsChanged(platform);
      throw new Error(
        [
          `The sandbox build embeds fingerprint ${info.fingerprintCandidates.join(", ") || "(none)"}; a normal build has ${fingerprintHash}.`,
          ...(changed.length > 0
            ? [`Changed during the build: ${changed.join(", ")}`]
            : []),
          "Point fingerprint.extraSources at source files, not at what a build writes.",
        ].join("\n"),
      );
    }
  }
  return info;
};
