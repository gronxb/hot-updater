import { canonicalizeAppVersion } from "../appVersion";
import { encodeChannelKey } from "../releaseCatalogScope";
import type { NativeArtifactProblemCode } from "./byteSource";
import {
  builtInBundlePathOf,
  type NativeArtifactInfo,
  type NativeArtifactKind,
  type UnreadableValue,
} from "./readNativeArtifact";

/** Why an artifact can't be imported, as the CLI and the Console say it. */
export interface NativeArtifactProblem {
  readonly code: NativeArtifactProblemCode;
  readonly message: string;
  /** With `ALREADY_IMPORTED`, the native build already registered. */
  readonly nativeBuildId?: string;
}

/** What an importable artifact registers as: a native build and its scope. */
export interface ImportableNativeBuild {
  readonly platform: "ios" | "android";
  readonly kind: NativeArtifactKind;
  readonly appId: string | null;
  readonly buildNumber: string | null;
  /** The MIN_BUNDLE_ID compiled in, the built-in bundle's ID. */
  readonly minBundleId: string;
  /** The channel the app reports: its own, or `production` without one. */
  readonly channel: string;
  readonly fingerprintHash: string | null;
  readonly appVersion: string | null;
  /** The built-in bundle's entry in the archive. */
  readonly builtInBundlePath: string;
}

export type NativeArtifactCheck =
  | { readonly ok: true; readonly build: ImportableNativeBuild }
  | { readonly ok: false; readonly problems: readonly NativeArtifactProblem[] };

/** The channel an app without a default channel reports. */
const DEFAULT_CHANNEL = "production";

const isUnreadable = (value: unknown): value is UnreadableValue =>
  typeof value === "object" && value !== null && "unreadable" in value;

/**
 * Whether a read artifact can be imported as a native build, whose built-in
 * bundle OTAs patch from, and what it registers as. It refuses an artifact
 * that ships no built-in bundle, such as a debug build, which loads its
 * JavaScript from Metro, one built without the native SDK's build step (no MIN_BUNDLE_ID), and
 * one the project's update strategy can't place: no fingerprint under the
 * fingerprint strategy, or no app version a device compares under the
 * appVersion strategy. With `appIds`, the identifiers the project's
 * `nativeBuild` schemes build, it refuses another app's artifact.
 */
export const checkNativeArtifact = (
  info: NativeArtifactInfo,
  {
    updateStrategy,
    appIds = [],
  }: {
    readonly updateStrategy: "fingerprint" | "appVersion";
    readonly appIds?: readonly string[];
  },
): NativeArtifactCheck => {
  const problems: NativeArtifactProblem[] = [];
  const refuse = (code: NativeArtifactProblemCode, message: string) =>
    problems.push({ code, message });

  if (info.builtInBundle === null) {
    refuse(
      "NO_BUILT_IN_BUNDLE",
      `The .${info.kind} has no ${builtInBundlePathOf(info.kind)}, so it ships no built-in bundle to patch from. A debug build loads its JavaScript from Metro, and a release build packs it there unless the project renames its bundle. Import a release build.`,
    );
  }
  const [minBundleId, ...otherMinBundleIds] = info.minBundleIdCandidates;
  if (minBundleId === undefined) {
    refuse(
      "NO_MIN_BUNDLE_ID",
      "The app's code holds no MIN_BUNDLE_ID: it was built without @hot-updater/react-native, or with a version of it that doesn't compile MIN_BUNDLE_ID in. Rebuild it with the @hot-updater/react-native this project uses.",
    );
  } else if (otherMinBundleIds.length > 0) {
    refuse(
      "AMBIGUOUS_MIN_BUNDLE_ID",
      `The app's code holds several UUIDv7 strings (${info.minBundleIdCandidates.join(", ")}), so which is MIN_BUNDLE_ID can't be told.`,
    );
  }

  let fingerprintHash: string | null = null;
  let appVersion: string | null = null;
  if (updateStrategy === "fingerprint") {
    const [fingerprint, ...others] = info.fingerprintCandidates;
    if (fingerprint === undefined) {
      refuse(
        "NO_FINGERPRINT",
        "The app's code holds no fingerprint, but hot-updater.config.ts updates by fingerprint: it was built without fingerprint.json, or with a @hot-updater/react-native that doesn't compile the fingerprint in, so its app can't check for fingerprint updates.",
      );
    } else if (others.length > 0) {
      refuse(
        "AMBIGUOUS_FINGERPRINT",
        `The app's code holds several SHA-256 strings (${info.fingerprintCandidates.join(", ")}), so which is its fingerprint can't be told.`,
      );
    } else {
      fingerprintHash = fingerprint;
    }
  } else if (info.appVersion === null) {
    refuse(
      "NO_APP_VERSION",
      `The app has no ${info.platform === "ios" ? "CFBundleShortVersionString" : "versionName"}, which the appVersion strategy updates by.`,
    );
  } else if (isUnreadable(info.appVersion)) {
    refuse("NO_APP_VERSION", `The app's ${info.appVersion.unreadable}.`);
  } else if (canonicalizeAppVersion(info.appVersion) === null) {
    refuse(
      "INVALID_SCOPE",
      `The app version ${info.appVersion} holds no version a device compares, such as 1.4.0, so no appVersion update targets it.`,
    );
  } else {
    appVersion = info.appVersion;
  }

  let channel = DEFAULT_CHANNEL;
  if (isUnreadable(info.channel)) {
    refuse(
      "INVALID_SCOPE",
      `${info.channel.unreadable}, so the channel its app reports can't be read.`,
    );
  } else if (info.channel !== null) {
    channel = info.channel;
    try {
      encodeChannelKey(channel);
    } catch (error) {
      refuse(
        "INVALID_SCOPE",
        `The app's channel ${JSON.stringify(channel)} is no channel a release can target: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  if (
    appIds.length > 0 &&
    info.appId !== null &&
    !appIds.includes(info.appId)
  ) {
    refuse(
      "APP_ID_MISMATCH",
      `The app is ${info.appId}, which no ${info.platform} scheme in nativeBuild builds (${appIds.join(", ")}): it is another app's build.`,
    );
  }

  if (problems.length > 0 || minBundleId === undefined) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    build: {
      platform: info.platform,
      kind: info.kind,
      appId: info.appId,
      buildNumber: info.buildNumber,
      minBundleId,
      channel,
      fingerprintHash,
      appVersion,
      builtInBundlePath: info.builtInBundle!.path,
    },
  };
};

/**
 * The refusal of an artifact whose built-in bundle is already registered:
 * the registry takes a MIN_BUNDLE_ID once.
 */
export const alreadyImportedProblem = (
  minBundleId: string,
  nativeBuildId: string | null,
): NativeArtifactProblem => ({
  code: "ALREADY_IMPORTED",
  ...(nativeBuildId === null ? {} : { nativeBuildId }),
  message:
    nativeBuildId === null
      ? `The built-in bundle ${minBundleId} is already registered, as a bundle that is no native build's.`
      : `This build is already registered as native build ${nativeBuildId} (built-in bundle ${minBundleId}).`,
});
