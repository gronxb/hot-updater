// @ts-check

import { parseJsonOutput } from "./cli.mjs";

/**
 * What the actions that choose between a native build and a bundle share:
 * their inputs, the registry lookup, and the deploy, over the project's CLI.
 *
 * @typedef {"android" | "ios"} Platform
 *
 * @typedef {object} NativeBuildRow The fields of a tracked build the actions read.
 * @property {string} id
 * @property {"aab" | "apk" | "app" | "ipa"} artifact_kind
 * @property {string} artifact_storage_uri
 * @property {string | null} [build_key] Null for a build registered from elsewhere.
 * @property {string | null} [submitted_to] The store track that took the build.
 * @property {string} [min_bundle_id] The oldest bundle ID the build runs.
 * @property {boolean} [is_sandbox] Whether the build is a sandbox build, as registered.
 * @property {string | null} [sandbox_url_scheme] The URL scheme a sandbox
 *   build registers, or null for a build registered before it was recorded.
 *
 * @typedef {object} StoreStatus What a store says of a build a run submitted.
 * @property {"testflight" | "play-internal" | "play-closed" | "play-open" | "play-production"} destination
 * @property {string | null} url The store's page of the app.
 * @property {string | null} version The store's label, such as `1.7.0 (66)`.
 * @property {string | null} state Such as `processing`, `ready`, or `draft`.
 * @property {number | null} expiresAtMs When the store stops offering the build.
 * @property {boolean} reusable Whether a tester can still get the build.
 *
 * @typedef {object} BuildTarget What a native build embeds.
 * @property {string | null} fingerprintHash
 * @property {string | null} appVersion
 *
 * @typedef {object} IosDevices Whether a found ad hoc `.ipa` still installs on
 *   the device registry's devices.
 * @property {boolean} reusable Whether a run can reuse it.
 * @property {"missing" | "expired" | "unreadable" | null} reason Why it can't.
 * @property {string[]} missing The devices a new build would add, as Apple's
 *   current state says.
 * @property {{ name: string, reason: string }[]} waiting The devices it lacks
 *   that a new build wouldn't add either, with why: disabled or refused at
 *   Apple, another account's, or Apple's state that couldn't be read.
 *
 * @typedef {BuildTarget & { platform: Platform, channel: string, nativeBuild: NativeBuildRow | null, downloadUrl?: string | null, store?: StoreStatus | null, iosDevices?: IosDevices, sandbox?: { appId: string, urlScheme: string, channel: string | null } }} NativeBuildFindResult
 *   What `native-build find --json` prints. `channel` is the one a new build
 *   embeds. `downloadUrl` is the storage's URL of the artifact, which anyone
 *   who has it can fetch until it expires, `store`, with `storeStatus`, what
 *   the store says of a submitted build, `iosDevices`, for a found ad hoc
 *   `.ipa`, whether it installs on the registry's devices, and `sandbox`, only
 *   for a sandbox scheme, its app ID, the URL scheme its links open, the
 *   matched build's or the one the next build registers, and the channel the
 *   matched build embeds, which may be another pull request's. The build's own
 *   record is `nativeBuild.is_sandbox`.
 *
 * @typedef {object} ShellDeps
 * @property {import("./cli.mjs").Cli} cli
 */

/** @type {readonly Platform[]} */
export const PLATFORMS = ["android", "ios"];

/**
 * The platforms of a comma-separated input, each once.
 *
 * @param {string} value
 * @returns {Platform[]}
 */
export const parsePlatforms = (value) => {
  /** @type {Platform[]} */
  const platforms = [];
  for (const name of value.split(/[\s,]+/)) {
    if (name === "") continue;
    if (!PLATFORMS.includes(/** @type {Platform} */ (name))) {
      throw new Error(`platforms takes android and ios, not ${name}.`);
    }
    if (!platforms.includes(/** @type {Platform} */ (name))) {
      platforms.push(/** @type {Platform} */ (name));
    }
  }
  if (platforms.length === 0) throw new Error("platforms is empty.");
  return platforms;
};

/**
 * The `<platform>-scheme` inputs that are set.
 *
 * @param {(name: string) => string} input
 * @returns {Partial<Record<Platform, string>>}
 */
export const parseSchemes = (input) => {
  /** @type {Partial<Record<Platform, string>>} */
  const schemes = {};
  for (const platform of PLATFORMS) {
    const scheme = input(`${platform.toUpperCase()}_SCHEME`);
    if (scheme !== "") schemes[platform] = scheme;
  }
  return schemes;
};

/**
 * A `true` or `false` input, by its `INPUT_*` name.
 *
 * @param {(name: string) => string} input
 * @param {string} name
 * @param {boolean} fallback
 */
export const parseFlag = (input, name, fallback) => {
  const value = input(name);
  if (value === "") return fallback;
  if (value === "true" || value === "false") return value === "true";
  throw new Error(
    `${name.toLowerCase().replaceAll("_", "-")} must be true or false.`,
  );
};

/**
 * The JSON a `--json` command prints.
 *
 * @param {ShellDeps} deps
 * @param {string[]} args
 * @param {{ quiet?: boolean }} [options] `quiet` keeps the JSON out of the
 *   job's log.
 */
export const runJson = async (deps, args, { quiet = false } = {}) => {
  const { code, stdout } = await deps.cli(args, { capture: true, quiet });
  if (code !== 0) {
    throw new Error(`hot-updater ${args.join(" ")} exited with ${code}.`);
  }
  return parseJsonOutput(stdout);
};

/**
 * The newest tracked build a build of the scheme would match. Without a
 * channel, it looks on the channel a build would embed. A command that fails
 * throws, which says nothing about the registry: no build is a `null`
 * `nativeBuild` in the result. The job's log never gets the result, whose
 * `downloadUrl` a public repository's log would hand to anyone.
 *
 * @param {ShellDeps} deps
 * @param {{ platform: Platform, scheme: string, channel?: string | null, storeStatus?: boolean }} options
 */
export const findNativeBuild = async (
  deps,
  { platform, scheme, channel, storeStatus = false },
) =>
  /** @type {NativeBuildFindResult} */ (
    await runJson(
      deps,
      [
        "native-build",
        "find",
        "-p",
        platform,
        ...(channel ? ["-c", channel] : []),
        "-s",
        scheme,
        ...(storeStatus ? ["--store-status"] : []),
        "--json",
      ],
      { quiet: true },
    )
  );

/** The store track each platform's native builds go to. */
export const STORES = /** @type {const} */ ({
  ios: { id: "testflight", name: "TestFlight" },
  android: { id: "play-internal", name: "Google Play internal testing" },
});

/** @param {BuildTarget} scope */
export const describeTarget = (scope) =>
  scope.fingerprintHash === null
    ? `app version ${scope.appVersion}`
    : `fingerprint ${scope.fingerprintHash}`;

/**
 * Rewrites a committed fingerprint.json that is older than the project, which
 * deploy refuses. A native build rewrites it, so only a deploy without one
 * needs this.
 *
 * @param {ShellDeps} deps
 * @param {BuildTarget} target
 */
export const refreshFingerprint = async (deps, target) => {
  if (target.fingerprintHash !== null) {
    await deps.cli(["fingerprint", "create"]);
  }
};

/**
 * Deploys one platform's bundle to `channel`, and returns the bundle's ID once
 * the registry says it reaches a native build with `target`.
 *
 * @param {ShellDeps} deps
 * @param {{ platform: Platform, channel: string, target: BuildTarget, message?: string, onDeployed?: () => void }} options
 *   `onDeployed` runs once `deploy` succeeds, before the registry is read.
 */
export const deployBundle = async (
  deps,
  { platform, channel, target, message, onDeployed },
) => {
  await deps.cli([
    "deploy",
    "-p",
    platform,
    "-c",
    channel,
    ...(message === undefined ? [] : ["-m", message]),
    // The exact version of the build, which deploy would otherwise read from
    // the project without the scheme.
    ...(target.appVersion === null ? [] : ["-t", target.appVersion]),
  ]);
  onDeployed?.();

  const [release] =
    /** @type {{ id: string, fingerprint_hash: string | null, target_app_version: string | null }[]} */ (
      await runJson(deps, [
        "bundle",
        "list",
        "-c",
        channel,
        "-p",
        platform,
        "--limit",
        "1",
        "--json",
      ])
    );
  if (release === undefined) {
    throw new Error(`deploy left no ${platform} bundle on ${channel}.`);
  }
  // The bundle reaches the build only with the build's own target.
  if (
    target.fingerprintHash === null
      ? release.target_app_version !== target.appVersion
      : release.fingerprint_hash !== target.fingerprintHash
  ) {
    throw new Error(
      `The ${platform} bundle ${release.id} targets ${release.fingerprint_hash ?? release.target_app_version}, but the native build has ${describeTarget(target)}.`,
    );
  }
  return release.id;
};
