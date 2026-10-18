import fs from "node:fs";
import path from "node:path";

const SDK = "@hot-updater/react-native";

const ERROR_NAME = "NativeSdkWithoutBuildFingerprintError";

/**
 * The installed React Native SDK predates build-time fingerprints: it reads
 * the fingerprint from Info.plist and AndroidManifest.xml, which hot-updater
 * no longer writes, so its builds would carry a stale one.
 */
export class NativeSdkWithoutBuildFingerprintError extends Error {
  constructor(version: string) {
    super(
      `${SDK}@${version} reads the fingerprint from Info.plist and AndroidManifest.xml, which this hot-updater no longer writes, so its builds would carry a stale fingerprint. Update ${SDK} to the version of hot-updater, then rebuild the app.`,
    );
    this.name = ERROR_NAME;
  }
}

export const isNativeSdkWithoutBuildFingerprintError = (
  error: unknown,
): error is NativeSdkWithoutBuildFingerprintError =>
  error instanceof Error && error.name === ERROR_NAME;

/**
 * Throws when the project's React Native SDK can't embed the fingerprint at
 * build time, which it shows by shipping the build step that does.
 */
export const assertNativeSdkEmbedsFingerprint = (cwd: string) => {
  // The node_modules folders above the project, as autolinking reads them;
  // NODE_PATH, which pnpm points at its store, doesn't count.
  let root: string | null = null;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", SDK);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      root = candidate;
      break;
    }
    if (path.dirname(dir) === dir) break;
  }
  // A project that doesn't install the SDK here builds it elsewhere.
  if (root === null) return;
  const manifest = path.join(root, "package.json");
  if (
    fs.existsSync(path.join(root, "android/hot-updater-fingerprint.gradle"))
  ) {
    return;
  }
  const { version } = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
    version?: string;
  };
  throw new NativeSdkWithoutBuildFingerprintError(version ?? "unknown");
};
