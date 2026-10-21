import type {
  NativeBuildArtifactKind,
  NativeBuildRow,
} from "@hot-updater/plugin-core";

import { shellQuote } from "./shell";

/** How each artifact installs, as the Console's install dialog shows it. */
export const nativeBuildArtifacts: Record<
  NativeBuildArtifactKind,
  { readonly label: string; readonly installs: string }
> = {
  apk: { label: "APK", installs: "Android device or emulator" },
  aab: { label: "AAB", installs: "Google Play or bundletool" },
  app: { label: "Simulator app", installs: "iOS Simulator" },
  ipa: { label: "IPA", installs: "registered iOS devices" },
};

/** The console route that redirects to a build's artifact in storage. */
export const nativeBuildDownloadPath = (id: string) =>
  `/api/native-builds/${encodeURIComponent(id)}/download`;

/**
 * The artifact's file name, the last path segment of its storage URI, so a
 * public URL's query or fragment stays out of it.
 */
export const nativeBuildFileName = (build: NativeBuildRow): string => {
  const path = build.artifact_storage_uri.split(/[?#]/, 1)[0] ?? "";
  const segment = path.split("/").at(-1) ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** What the build compiled in: its app version, or its fingerprint. */
export const nativeBuildTarget = (build: NativeBuildRow) =>
  build.app_version === null
    ? { label: "Fingerprint", value: build.fingerprint_hash ?? "" }
    : { label: "App version", value: build.app_version };

const UNITS = ["B", "KB", "MB", "GB"] as const;

/** A byte count in the largest unit that keeps it at or above 1. */
export const formatByteSize = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
};

/**
 * The commands that install a simulator build: unzip the download, then
 * install the `.app` on the booted simulator.
 */
export const simulatorInstallCommand = (build: NativeBuildRow) => {
  const archive = nativeBuildFileName(build);
  const app = archive.replace(/\.zip$/, "");
  return `unzip -o ${shellQuote(archive)} && xcrun simctl install booted ${shellQuote(app)}`;
};

/** The command that installs a downloaded APK on an Android device or emulator. */
export const apkInstallCommand = (build: NativeBuildRow) =>
  `adb install -r ${shellQuote(nativeBuildFileName(build))}`;
