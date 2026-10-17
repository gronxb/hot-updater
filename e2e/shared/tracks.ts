import path from "node:path";

/**
 * The app shells the shared scenarios run in. `greenfield` is the example app
 * itself; `brownfield` packages the same example as an XCFramework and an AAR
 * and runs it inside the native apps in `examples/brownfield-host`.
 */
export const e2eTracks = ["greenfield", "brownfield"] as const;
export type E2eTrack = (typeof e2eTracks)[number];

export function parseE2eTrack(value: string | undefined): E2eTrack {
  if (value === undefined) return "greenfield";
  const track = e2eTracks.find((entry) => entry === value);
  if (!track) throw new Error(`Unknown E2E track: ${value}`);
  return track;
}

/** The suite a track runs when no suite or scenario is selected. */
export function defaultSuiteForTrack(track: E2eTrack): string {
  return track === "brownfield" ? "brownfield" : "default";
}

const iosProjectDir = (track: E2eTrack) =>
  track === "brownfield"
    ? "examples/brownfield-host/ios"
    : "examples/v0.85.0/ios";

/**
 * The DerivedData directory of the iOS app a track installs;
 * `HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH` resolves against the track's
 * project directory.
 */
export function iosDerivedDataDir(
  track: E2eTrack,
  repositoryRoot: string,
  env: NodeJS.ProcessEnv,
): string {
  return path.resolve(
    repositoryRoot,
    iosProjectDir(track),
    env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH || "build",
  );
}

/** The built app the runner installs, unless a binary path overrides it. */
export function nativeAppPath(
  track: E2eTrack,
  platform: "ios" | "android",
  repositoryRoot: string,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "ios") {
    return path.resolve(
      env.HOT_UPDATER_E2E_IOS_BINARY_PATH ??
        path.join(
          iosDerivedDataDir(track, repositoryRoot, env),
          "Build/Products/Release-iphonesimulator/HotUpdaterExample.app",
        ),
    );
  }
  return path.resolve(
    repositoryRoot,
    env.HOT_UPDATER_E2E_ANDROID_BINARY_PATH ??
      (track === "brownfield"
        ? "examples/brownfield-host/android/app/build/outputs/apk/release/app-release.apk"
        : "examples/v0.85.0/android/app/build/outputs/apk/release/app-release.apk"),
  );
}
