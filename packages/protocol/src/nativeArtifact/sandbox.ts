/**
 * What a sandbox build is, wherever it is built or read: `sandbox: true` on a
 * `nativeBuild` scheme adds a native layer to the app, which a normal build
 * never compiles.
 */
import { assertCanonicalChannelName } from "../releaseCatalogScope";

/**
 * The literal the sandbox layer's code holds, in `ios/HotUpdater/Sandbox` and
 * `android/src/sandbox`: reading an artifact's strings finds it. Its length
 * is its own among the lengths those reads keep.
 */
export const SANDBOX_CODE_MARKER = "HOT_UPDATER_SANDBOX_NATIVE_LAYER";

/** The Info.plist key an iOS sandbox build declares itself with. */
export const SANDBOX_INFO_PLIST_KEY = "HOT_UPDATER_SANDBOX";

/** The `<meta-data>` an Android sandbox build declares itself with. */
export const SANDBOX_META_DATA = "com.hotupdater.SANDBOX";

/** The activity that takes an Android sandbox build's launcher entry and links. */
export const SANDBOX_ACTIVITY = "com.hotupdater.HotUpdaterSandboxActivity";

/** The `applicationIdSuffix` an Android sandbox build appends. */
export const SANDBOX_APPLICATION_ID_SUFFIX = ".sandbox";

const SANDBOX_CHANNEL_PREFIX = "sandbox-";
const SANDBOX_URL_SCHEME_PREFIX = "hu-sandbox-";

/**
 * The channel a scheme's sandbox build registers on. `sandbox-*` is reserved:
 * it is how the registry tells a sandbox build, with no column of its own.
 */
export const sandboxChannelOf = (scheme: string): string =>
  `${SANDBOX_CHANNEL_PREFIX}${scheme}`;

/** Whether a channel is reserved for sandbox builds. */
export const isSandboxChannel = (channel: string): boolean =>
  channel.startsWith(SANDBOX_CHANNEL_PREFIX);

/**
 * The URL scheme only a sandbox build registers, derived from the app's ID:
 * the app's own scheme would ask which app to open beside the store app.
 */
export const sandboxUrlSchemeOf = (appId: string): string =>
  `${SANDBOX_URL_SCHEME_PREFIX}${appId.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;

/** Whether a URL scheme is one a sandbox build registers. */
export const isSandboxUrlScheme = (scheme: string): boolean =>
  scheme.toLowerCase().startsWith(SANDBOX_URL_SCHEME_PREFIX);

/** What a preview link asks a sandbox build to run. */
export interface PreviewLink {
  /** The sandbox's URL scheme, in lower case. */
  readonly urlScheme: string;
  readonly channel: string;
  /** The fingerprint the channel's bundles need; another build refuses them. */
  readonly fingerprintHash: string;
}

/**
 * The link a preview QR holds. `appId` is the scheme's `bundleIdentifier` or
 * `packageName`: the ID before the Android sandbox's `.sandbox` suffix.
 */
export const createPreviewLink = ({
  appId,
  channel,
  fingerprintHash,
}: {
  readonly appId: string;
  readonly channel: string;
  readonly fingerprintHash: string;
}): string => {
  assertCanonicalChannelName(channel);
  return `${sandboxUrlSchemeOf(appId)}://hot-updater/preview?channel=${encodeURIComponent(channel)}&fingerprint=${encodeURIComponent(fingerprintHash)}`;
};

const PREVIEW_LINK =
  /^(hu-sandbox-[a-z0-9-]+):\/\/hot-updater\/preview\?([^#]*)$/iu;
const MAX_FINGERPRINT_LENGTH = 256;

/**
 * What a preview link says, or null for anything else: another shape, a
 * repeated or missing parameter, or a channel no release can target. Native
 * code parses it the same way before any JavaScript runs, in
 * HotUpdaterSandboxLink, and shares the vectors in test-utils'
 * `sandbox-preview-links.json`.
 */
export const parsePreviewLink = (link: string): PreviewLink | null => {
  const match = PREVIEW_LINK.exec(link);
  if (match === null) return null;
  const parameters = new Map<string, string>();
  for (const parameter of match[2]!.split("&")) {
    const separator = parameter.indexOf("=");
    if (separator === -1) return null;
    const name = parameter.slice(0, separator);
    if (parameters.has(name)) return null;
    let value: string;
    try {
      value = decodeURIComponent(parameter.slice(separator + 1));
    } catch {
      return null;
    }
    parameters.set(name, value);
  }
  const channel = parameters.get("channel");
  const fingerprintHash = parameters.get("fingerprint");
  if (
    channel === undefined ||
    fingerprintHash === undefined ||
    fingerprintHash.length === 0 ||
    fingerprintHash.length > MAX_FINGERPRINT_LENGTH
  ) {
    return null;
  }
  try {
    assertCanonicalChannelName(channel);
  } catch {
    return null;
  }
  return {
    urlScheme: match[1]!.toLowerCase(),
    channel,
    fingerprintHash,
  };
};
