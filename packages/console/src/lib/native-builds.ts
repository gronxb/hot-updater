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

/**
 * How a native build reaches people: the store track it was submitted to,
 * else its artifact, an `.ipa` by its export method when the registry has
 * it. Builds of one channel, platform and sandbox flag with one
 * distribution form a distribution path; a newer build on it is the one
 * people get there.
 */
export type NativeBuildDistribution =
  | NonNullable<NativeBuildRow["submitted_to"]>
  | NativeBuildArtifactKind
  | `ipa-${NonNullable<NativeBuildRow["export_method"]>}`;

/** A build's distribution, from its row. */
export const nativeBuildDistribution = (
  build: Pick<
    NativeBuildRow,
    "submitted_to" | "artifact_kind" | "export_method"
  >,
): NativeBuildDistribution =>
  build.submitted_to ??
  (build.artifact_kind === "ipa" && build.export_method !== null
    ? `ipa-${build.export_method}`
    : build.artifact_kind);

/** The distribution path a build is on, as one key. */
export const nativeBuildPathKey = (
  build: Pick<
    NativeBuildRow,
    | "channel_id"
    | "platform"
    | "is_sandbox"
    | "submitted_to"
    | "artifact_kind"
    | "export_method"
  >,
): string =>
  JSON.stringify([
    build.channel_id,
    build.platform,
    build.is_sandbox,
    nativeBuildDistribution(build),
  ]);

/** A platform's name as the console shows it. */
export const platformLabel = (platform: "ios" | "android") =>
  platform === "ios" ? "iOS" : "Android";

/**
 * A build as the CLI names it, such as `iOS 1.7.0 (66)`: the store's label
 * when a store took it, else its app version, the one its artifact reports
 * on a fingerprint build, and build number. Null when it reports neither,
 * for the caller to name it another way.
 */
export const nativeBuildLabel = (
  build: Pick<
    NativeBuildRow,
    | "platform"
    | "submitted_version"
    | "app_version"
    | "native_app_version"
    | "build_number"
  >,
): string | null => {
  const label =
    build.submitted_version ??
    [
      build.app_version ?? build.native_app_version ?? null,
      build.build_number === null ? null : `(${build.build_number})`,
    ]
      .filter((part) => part !== null)
      .join(" ");
  return label === "" ? null : `${platformLabel(build.platform)} ${label}`;
};

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
  return `${location.origin}${consolePathOf(location, id)}${nativeBuildDownloadPath(id)}?${NATIVE_BUILD_DOWNLOAD_TOKEN_PARAM}=${encodeURIComponent(token)}`;
};

/**
 * The console's own path, from a page of build `id` under it: empty at the
 * root of its host.
 */
export const consolePathOf = (
  location: { readonly pathname: string },
  id: string,
) => {
  const page = nativeBuildDetailPath(id);
  return location.pathname.endsWith(page)
    ? location.pathname.slice(0, -page.length)
    : "";
};

/**
 * The Console's own path, from where the browser is and where the router says
 * it is: the prefix a host serves the Console under, or empty at its root.
 */
export const consolePathFromRouter = (
  location: { readonly pathname: string },
  routerPathname: string,
) => {
  const path = location.pathname.replace(/\/$/u, "");
  const route = routerPathname.replace(/\/$/u, "");
  return path.endsWith(route) ? path.slice(0, path.length - route.length) : "";
};

/**
 * The Console's own path, from one of its Native builds pages, where the
 * profile's answer lands: empty at the root of its host.
 */
export const consolePathOfNativeBuildsPage = (location: {
  readonly pathname: string;
}) => {
  const at = location.pathname.lastIndexOf("/native-builds");
  return at < 0 ? "" : location.pathname.slice(0, at);
};

/** The console page of one native build. */
export const nativeBuildDetailPath = (id: string) =>
  `/native-builds/${encodeURIComponent(id)}`;

/**
 * How long an Install button's link works. It sits in the `itms-services` URL,
 * Safari's history and the installer's logs, and its holder can fetch the IPA
 * with every UDID in its profile, so it lasts only as long as an install takes.
 */
export const NATIVE_BUILD_INSTALL_LINK_TTL_MS = 60 * 60 * 1000;

/** This iPhone's own copy of its UDID, as its profile reported it. */
export const IOS_UDID_STORAGE_KEY = "hot-updater-ios-udid";

/**
 * This iPhone's receipt of its UDID: what its profile's answer signed for the
 * signed-in person, which Request access takes.
 */
export const IOS_DEVICE_RECEIPT_STORAGE_KEY = "hot-updater-ios-device-receipt";

/** A device's UDID: 40 hex digits, or 8 and 16 joined by a hyphen. */
export const IOS_UDID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{8}-[0-9a-f]{16})$/iu;

/** The Console page of the iOS device registry, inside Native builds. */
export const IOS_DEVICES_PATH = "/native-builds/devices";

/** The route that hands an iPhone the profile that reads its UDID. */
export const IOS_DEVICE_PROFILE_PATH =
  "/_hot-updater/devices/device.mobileconfig";

/** Where iOS posts the profile's answer. */
export const IOS_DEVICE_RESPONSE_PATH = "/_hot-updater/devices/device-response";

/** The query parameter of the profile routes: the capability that signs them. */
export const IOS_DEVICE_TOKEN_PARAM = "t";

/** A device profile's link, under the Console's path on the page's own address. */
export const iosDeviceProfileUrl = (consolePath: string, token: string) =>
  `${consolePath}${IOS_DEVICE_PROFILE_PATH}?${IOS_DEVICE_TOKEN_PARAM}=${encodeURIComponent(token)}`;

/** The command that registers requested iPhones from a terminal. */
export const IOS_DEVICES_ADD_COMMAND =
  "npx hot-updater native-build devices add";

/** The UDID as the iOS devices page shows it: its last six characters. */
export const maskIosUdid = (udid: string) => `…${udid.slice(-6)}`;

/** The route of a build's install manifest, as `itms-services` opens it. */
export const nativeBuildManifestPath = (id: string) =>
  `/_hot-updater/native-builds/${encodeURIComponent(id)}/manifest.plist`;

/**
 * What an iPhone opens to install a build: the manifest's URL, signed with a
 * token that also lets the installer download the IPA.
 */
export const nativeBuildItmsUrl = (
  location: { readonly origin: string; readonly pathname: string },
  id: string,
  token: string,
) => {
  const manifest = `${location.origin}${consolePathOf(location, id)}${nativeBuildManifestPath(id)}?${NATIVE_BUILD_DOWNLOAD_TOKEN_PARAM}=${encodeURIComponent(token)}`;
  return `itms-services://?action=download-manifest&url=${encodeURIComponent(manifest)}`;
};

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
 * The command that downloads a simulator build or an APK, installs it on the
 * booted simulator or the connected device, and opens it, in the project with
 * its `hot-updater.config.ts`.
 */
export const nativeBuildInstallCommand = (build: NativeBuildRow) =>
  `npx hot-updater native-build install ${shellQuote(build.id)}`;
