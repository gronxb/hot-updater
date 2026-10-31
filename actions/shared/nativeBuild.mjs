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
 *
 * @typedef {object} BuildTarget What a native build embeds.
 * @property {string | null} fingerprintHash
 * @property {string | null} appVersion
 *
 * @typedef {BuildTarget & { platform: Platform, channel: string, nativeBuild: NativeBuildRow | null }} NativeBuildFindResult
 *   What `native-build find --json` prints.
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
 */
export const runJson = async (deps, args) => {
  const { code, stdout } = await deps.cli(args, { capture: true });
  if (code !== 0) {
    throw new Error(`hot-updater ${args.join(" ")} exited with ${code}.`);
  }
  return parseJsonOutput(stdout);
};

/**
 * The newest tracked build a build of the scheme would match. Without a
 * channel, it looks on the channel a build would embed. A command that fails
 * throws, which says nothing about the registry: no build is a `null`
 * `nativeBuild` in the result.
 *
 * @param {ShellDeps} deps
 * @param {{ platform: Platform, scheme: string, channel?: string | null }} options
 */
export const findNativeBuild = async (deps, { platform, scheme, channel }) =>
  /** @type {NativeBuildFindResult} */ (
    await runJson(deps, [
      "native-build",
      "find",
      "-p",
      platform,
      ...(channel ? ["-c", channel] : []),
      "-s",
      scheme,
      "--json",
    ])
  );

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
 * @param {{ platform: Platform, channel: string, target: BuildTarget, message?: string }} options
 */
export const deployBundle = async (
  deps,
  { platform, channel, target, message },
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
