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

/**
 * The `CFBundleURLName` of the URL type an iOS sandbox build registers its URL
 * scheme with, which the build reads its own scheme from.
 */
export const SANDBOX_URL_TYPE_NAME = "hot-updater-sandbox";

/**
 * The `<meta-data>` of `SANDBOX_ACTIVITY` that names the URL scheme an Android
 * sandbox build registers, which the build reads its own scheme from.
 */
export const SANDBOX_URL_SCHEME_META_DATA = "com.hotupdater.sandbox.URL_SCHEME";

const SANDBOX_CHANNEL_PREFIX = "sandbox-";
const SANDBOX_URL_SCHEME_PREFIX = "hu-sandbox-";

/**
 * The channel a scheme's sandbox build registers on. `sandbox-*` is reserved:
 * only a sandbox build registers there, and the registry records `sandbox` on
 * it.
 */
export const sandboxChannelOf = (scheme: string): string =>
  `${SANDBOX_CHANNEL_PREFIX}${scheme}`;

/** Whether a channel is reserved for sandbox builds. */
export const isSandboxChannel = (channel: string): boolean =>
  channel.startsWith(SANDBOX_CHANNEL_PREFIX);

/**
 * The URL scheme a sandbox build registers when its scheme sets none, derived
 * from the app's ID: the app's own scheme would ask which app to open beside
 * the store app.
 */
export const sandboxUrlSchemeOf = (appId: string): string =>
  `${SANDBOX_URL_SCHEME_PREFIX}${appId.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;

/**
 * Whether a URL scheme has the prefix of the derived one: how an artifact built
 * before the URL scheme could be set is read, which registered no other.
 */
export const isSandboxUrlScheme = (scheme: string): boolean =>
  scheme.toLowerCase().startsWith(SANDBOX_URL_SCHEME_PREFIX);

const CONFIGURED_URL_SCHEME = /^[a-z][a-z0-9+.-]{0,63}$/u;
const SYSTEM_URL_SCHEMES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "file",
  "data",
  "javascript",
]);

/**
 * Whether `sandbox: { urlScheme }` can name a URL scheme: lower case, a letter
 * then up to 63 letters, digits, `+`, `.` or `-`, and none the system or a
 * browser owns.
 */
export const isConfigurableSandboxUrlScheme = (urlScheme: string): boolean =>
  CONFIGURED_URL_SCHEME.test(urlScheme) && !SYSTEM_URL_SCHEMES.has(urlScheme);

/** What a preview link asks a sandbox build to run. */
export interface PreviewLink {
  /** The sandbox's URL scheme, in lower case. */
  readonly urlScheme: string;
  readonly channel: string;
  /** The fingerprint the channel's bundles need; another build refuses them. */
  readonly fingerprintHash: string;
}

/**
 * The link a preview QR holds. `urlScheme` is the one the sandbox build
 * registered; without it, the one derived from `appId`, the scheme's
 * `bundleIdentifier` or `packageName`: the ID before the Android sandbox's
 * `.sandbox` suffix.
 */
export const createPreviewLink = ({
  urlScheme,
  appId,
  channel,
  fingerprintHash,
}: {
  readonly channel: string;
  readonly fingerprintHash: string;
} & (
  | { readonly urlScheme: string; readonly appId?: string }
  | { readonly urlScheme?: undefined; readonly appId: string }
)): string => {
  assertCanonicalChannelName(channel);
  const scheme = urlScheme ?? sandboxUrlSchemeOf(appId as string);
  return `${scheme.toLowerCase()}://hot-updater/preview?channel=${encodeURIComponent(channel)}&fingerprint=${encodeURIComponent(fingerprintHash)}`;
};

/** Any URL scheme: which app's it is, the app that opens the link decides. */
const PREVIEW_LINK =
  /^([a-z][a-z0-9+.-]*):\/\/hot-updater\/preview\?([^#]*)$/iu;
const MAX_FINGERPRINT_LENGTH = 256;

/**
 * What a preview link says, or null for anything else: another shape, a
 * repeated or missing parameter, or a channel no release can target. It takes
 * any URL scheme: a sandbox build refuses a link of another scheme than its
 * own. Native code parses it the same way before any JavaScript runs, in
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
