import type {
  NativeBuildArtifactKind,
  NativeBuildRow,
  NativeBuildScope,
} from "@hot-updater/plugin-core";
import {
  canonicalizeAppVersion,
  createReleaseCatalogScopeKey,
  decodeChannelKey,
  encodeChannelKey,
} from "@hot-updater/protocol";

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

/** A platform's name as the console shows it. */
export const platformLabel = (platform: "ios" | "android") =>
  platform === "ios" ? "iOS" : "Android";

/** The console route that redirects to a build's artifact in storage. */
export const nativeBuildDownloadPath = (id: string) =>
  `/api/native-builds/${encodeURIComponent(id)}/download`;

/** The query parameter of a signed download link: its token. */
export const NATIVE_BUILD_DOWNLOAD_TOKEN_PARAM = "t";

/**
 * A build's signed download link, under the console's path on the page's own
 * address, whatever the page, so it opens where the person who copied it
 * reached the console.
 */
export const nativeBuildSignedDownloadUrl = (
  location: { readonly origin: string; readonly pathname: string },
  id: string,
  token: string,
) => {
  const page = nativeBuildDetailPath(id);
  const base = location.pathname.endsWith(page)
    ? location.pathname.slice(0, -page.length)
    : "";
  return `${location.origin}${base}${nativeBuildDownloadPath(id)}?${NATIVE_BUILD_DOWNLOAD_TOKEN_PARAM}=${encodeURIComponent(token)}`;
};

/** The console page of one native build. */
export const nativeBuildDetailPath = (id: string) =>
  `/native-builds/${encodeURIComponent(id)}`;

const CHANNEL_ID_PREFIX = "channel:";

/** A channel row's ID, `channel:` and its channel key. */
export const channelIdOf = (channel: string) =>
  `${CHANNEL_ID_PREFIX}${encodeChannelKey(channel)}`;

/** The name of the channel a build embeds, decoded from its channel ID: no read. */
export const nativeBuildChannel = (build: Pick<NativeBuildRow, "channel_id">) =>
  decodeChannelKey(build.channel_id.slice(CHANNEL_ID_PREFIX.length));

/** The scope a build was registered in, as `findNativeBuild` takes it. */
export const nativeBuildScope = (build: NativeBuildRow): NativeBuildScope =>
  build.fingerprint_hash === null
    ? {
        platform: build.platform,
        channel: nativeBuildChannel(build),
        fingerprintHash: null,
        appVersion: build.app_version ?? "",
      }
    : {
        platform: build.platform,
        channel: nativeBuildChannel(build),
        fingerprintHash: build.fingerprint_hash,
        appVersion: null,
      };

/**
 * The Release Catalog scope whose releases an install of the build is
 * offered. A fingerprint build's scope key is that catalog's own key; an
 * app-version build's adds its exact app version, which the catalog of
 * every app version leaves out.
 */
export const nativeBuildCatalogScopeKey = (build: NativeBuildRow): string => {
  const channelKey = build.channel_id.slice(CHANNEL_ID_PREFIX.length);
  return build.fingerprint_hash === null
    ? createReleaseCatalogScopeKey({
        channelKey,
        platform: build.platform,
        strategy: "APP_VERSION",
      })
    : createReleaseCatalogScopeKey({
        channelKey,
        fingerprintHash: build.fingerprint_hash,
        platform: build.platform,
        strategy: "FINGERPRINT",
      });
};

/**
 * The native build scope a release serves, or null when no one build has
 * it: a release of an app version range, rather than one exact version,
 * targets many builds.
 */
export const releaseNativeBuildScope = (release: {
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly fingerprintHash: string | null;
  readonly targetAppVersion: string | null;
}): NativeBuildScope | null => {
  if (release.fingerprintHash !== null) {
    return {
      platform: release.platform,
      channel: release.channel,
      fingerprintHash: release.fingerprintHash,
      appVersion: null,
    };
  }
  const target = release.targetAppVersion;
  if (target === null || canonicalizeAppVersion(target) !== target) {
    return null;
  }
  return {
    platform: release.platform,
    channel: release.channel,
    fingerprintHash: null,
    appVersion: target,
  };
};

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
