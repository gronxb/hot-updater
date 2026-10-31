/**
 * What a sandbox build is, wherever it is built or read: `sandbox: true` on a
 * `nativeBuild` scheme adds a native layer to the app, which a normal build
 * never compiles.
 */

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

/** The `applicationIdSuffix` an Android sandbox build appends. */
export const SANDBOX_APPLICATION_ID_SUFFIX = ".sandbox";

const SANDBOX_CHANNEL_PREFIX = "sandbox-";

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
  `hu-sandbox-${appId.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;
