// @ts-check

import { parseJsonOutput, reportBuildLogs } from "../../shared/cli.mjs";
import {
  renderClosedComment,
  renderPreviewComment,
  consoleLink,
} from "./comment.mjs";
import { findComment, updateComment, upsertComment } from "./github.mjs";

export { parseJsonOutput };

/**
 * @typedef {import("./comment.mjs").Platform} Platform
 * @typedef {import("./comment.mjs").PlatformPreview} PlatformPreview
 *
 * @typedef {object} Inputs
 * @property {string} consoleUrl
 * @property {Platform[]} platforms
 * @property {Partial<Record<Platform, string>>} schemes The `nativeBuild`
 *   scheme each platform builds.
 * @property {string} previewChannel The channel preview builds embed.
 * @property {string} channel The pull request's channel.
 * @property {boolean} credit
 * @property {boolean} comment Whether to write the pull request comment.
 * @property {"preview" | "cleanup"} mode
 *
 * @typedef {object} PullRequestEvent
 * @property {string} action
 * @property {boolean} fromFork Whether the pull request comes from a fork,
 *   whose workflow runs get no secrets.
 * @property {number} number
 * @property {string} title
 * @property {string} headSha
 *
 * @typedef {object} Deps
 * @property {(args: string[], options?: { capture?: boolean }) => Promise<{ code: number, stdout: string }>} cli
 *   Runs the project's hot-updater CLI. Without `capture`, it prints the
 *   command's output and throws when the command fails; with it, it returns
 *   the output and the exit code.
 * @property {import("../../shared/cli.mjs").BuildLogs} buildLogs
 * @property {typeof fetch} fetch
 * @property {import("./github.mjs").GitHubContext | null} github
 * @property {(name: string, value: string) => void} setOutput
 * @property {{ info: (message: string) => void, notice: (message: string) => void, group: <T>(name: string, run: () => Promise<T>) => Promise<T> }} log
 *
 * @typedef {object} NativeBuildFindResult What `native-build find --json` prints.
 * @property {Platform} platform
 * @property {string} channel
 * @property {string | null} fingerprintHash
 * @property {string | null} appVersion
 * @property {{ id: string, artifact_kind: import("./comment.mjs").ArtifactKind } | null} nativeBuild
 */

const PLATFORMS = /** @type {const} */ (["android", "ios"]);

/**
 * The action's inputs, from the environment its composite step passes.
 *
 * @param {Record<string, string | undefined>} env
 * @param {PullRequestEvent} event
 * @returns {Inputs}
 */
export const parseInputs = (env, event) => {
  /** @param {string} name */
  const input = (name) => env[`INPUT_${name}`]?.trim() ?? "";
  /** @param {string} name @param {boolean} fallback */
  const flag = (name, fallback) => {
    const value = input(name);
    if (value === "") return fallback;
    if (value === "true" || value === "false") return value === "true";
    throw new Error(`${name.toLowerCase()} must be true or false.`);
  };

  const consoleUrl = input("CONSOLE_URL");
  if (consoleUrl === "") throw new Error("console-url is required.");
  if (!/^https?:\/\//.test(consoleUrl)) {
    throw new Error("console-url must be the Console's http(s) URL.");
  }

  const mode = input("MODE") || "auto";
  if (mode !== "auto" && mode !== "preview" && mode !== "cleanup") {
    throw new Error("mode must be auto, preview, or cleanup.");
  }

  /** @type {Platform[]} */
  const platforms = [];
  for (const name of (input("PLATFORMS") || "android").split(/[\s,]+/)) {
    if (name === "") continue;
    if (!PLATFORMS.includes(/** @type {Platform} */ (name))) {
      throw new Error(`platforms takes android and ios, not ${name}.`);
    }
    if (!platforms.includes(/** @type {Platform} */ (name))) {
      platforms.push(/** @type {Platform} */ (name));
    }
  }
  if (platforms.length === 0) throw new Error("platforms is empty.");

  /** @type {Partial<Record<Platform, string>>} */
  const schemes = {};
  for (const platform of PLATFORMS) {
    const scheme = input(`${platform.toUpperCase()}_SCHEME`);
    if (scheme !== "") schemes[platform] = scheme;
  }

  const previewChannel = input("PREVIEW_CHANNEL") || "preview";
  const channel = input("CHANNEL") || `pr-${event.number}`;
  if (channel === previewChannel) {
    throw new Error(
      `channel and preview-channel are both ${channel}: deploy each pull request to its own channel, since a channel a native build embeds can't be deleted.`,
    );
  }

  const resolvedMode =
    mode === "auto"
      ? event.action === "closed"
        ? "cleanup"
        : "preview"
      : mode;
  if (resolvedMode === "preview") {
    for (const platform of platforms) {
      if (schemes[platform] === undefined) {
        throw new Error(
          `${platform}-scheme is required: the nativeBuild.${platform} scheme the preview build uses.`,
        );
      }
    }
  }

  return {
    consoleUrl,
    platforms,
    schemes,
    previewChannel,
    channel,
    credit: flag("CREDIT", true),
    comment: flag("COMMENT", true),
    mode: resolvedMode,
  };
};

/**
 * @param {Deps} deps
 * @param {string[]} args
 */
const json = async (deps, args) => {
  const { code, stdout } = await deps.cli(args, { capture: true });
  if (code !== 0) {
    throw new Error(`hot-updater ${args.join(" ")} exited with ${code}.`);
  }
  return parseJsonOutput(stdout);
};

/**
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {Platform} platform
 */
const findNativeBuild = async (deps, inputs, platform) =>
  /** @type {NativeBuildFindResult} */ (
    await json(deps, [
      "native-build",
      "find",
      "-p",
      platform,
      "-c",
      inputs.previewChannel,
      "-s",
      /** @type {string} */ (inputs.schemes[platform]),
      "--json",
    ])
  );

/** @param {{ fingerprintHash: string | null, appVersion: string | null }} scope */
const describeTarget = (scope) =>
  scope.fingerprintHash === null
    ? `app version ${scope.appVersion}`
    : `fingerprint ${scope.fingerprintHash}`;

/**
 * What `native-build <platform> --json` prints last: the build, with what
 * its artifact embeds, its record in Hot Updater, and why it has none.
 *
 * @typedef {object} NativeBuildJson
 * @property {{ channel: string, fingerprintHash: string | null, appVersion: string | null }} build
 * @property {{ id: string, artifact_kind: import("./comment.mjs").ArtifactKind } | null} nativeBuild
 * @property {{ skipped: "debug" | "dry-run" | null }} [registration]
 */

/**
 * Deploys one platform's bundle to the pull request's channel, after
 * building and registering a native build when the registry has none for
 * the project's fingerprint, or app version, on the preview channel.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {PullRequestEvent} event
 * @param {Platform} platform
 * @returns {Promise<PlatformPreview>}
 */
const previewPlatform = async (deps, inputs, event, platform) => {
  const found = await findNativeBuild(deps, inputs, platform);
  /** @type {{ fingerprintHash: string | null, appVersion: string | null }} */
  let target = {
    fingerprintHash: found.fingerprintHash,
    appVersion: found.appVersion,
  };
  /** @type {{ id: string, artifactKind: import("./comment.mjs").ArtifactKind }} */
  let nativeBuild;
  const built = found.nativeBuild === null;
  if (found.nativeBuild === null) {
    deps.log.info(
      `No ${platform} native build on ${inputs.previewChannel} has ${describeTarget(found)}: building one.`,
    );
    const scheme = /** @type {string} */ (inputs.schemes[platform]);
    const since = Date.now();
    // Every native build is tracked, so the preview can install it.
    const registered = /** @type {NativeBuildJson} */ (
      await json(deps, [
        "native-build",
        platform,
        "--scheme",
        scheme,
        "--json",
      ]).catch((error) => {
        reportBuildLogs(deps, `${platform}-build-log`, since);
        throw error;
      })
    );
    if (registered.build.channel !== inputs.previewChannel) {
      throw new Error(
        `native-build ${platform} built a native build that embeds the ${registered.build.channel} channel, not ${inputs.previewChannel}. An Expo project sets it in the @hot-updater/expo config plugin.`,
      );
    }
    if (registered.nativeBuild === null) {
      throw new Error(
        registered.registration?.skipped === "debug"
          ? `The ${platform}-scheme ${scheme} builds Debug, which Hot Updater does not track, so a preview can't install it: use a Release scheme.`
          : `native-build ${platform} tracked no native build.`,
      );
    }
    // What the artifact embeds, such as an app version an xcconfig sets.
    target = {
      fingerprintHash: registered.build.fingerprintHash,
      appVersion: registered.build.appVersion,
    };
    nativeBuild = {
      id: registered.nativeBuild.id,
      artifactKind: registered.nativeBuild.artifact_kind,
    };
  } else {
    deps.log.info(
      `Reusing ${platform} native build ${found.nativeBuild.id}, which has ${describeTarget(found)}.`,
    );
    nativeBuild = {
      id: found.nativeBuild.id,
      artifactKind: found.nativeBuild.artifact_kind,
    };
    // A committed fingerprint.json can be older than the project, which
    // deploy refuses; the build would have rewritten it.
    if (found.fingerprintHash !== null) {
      await deps.cli(["fingerprint", "create"]);
    }
  }

  await deps.cli([
    "deploy",
    "-p",
    platform,
    "-c",
    inputs.channel,
    "-m",
    `#${event.number} ${event.title}`,
    // The exact version of the build, which deploy would otherwise read from
    // the project without the scheme.
    ...(target.appVersion === null ? [] : ["-t", target.appVersion]),
  ]);

  const [release] =
    /** @type {{ id: string, fingerprint_hash: string | null, target_app_version: string | null }[]} */ (
      await json(deps, [
        "bundle",
        "list",
        "-c",
        inputs.channel,
        "-p",
        platform,
        "--limit",
        "1",
        "--json",
      ])
    );
  if (release === undefined) {
    throw new Error(`deploy left no ${platform} bundle on ${inputs.channel}.`);
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

  return { platform, target, nativeBuild, built, bundleId: release.id };
};

/**
 * The link the Console's QR code of `channel` holds, from the Console
 * itself, or null when it serves none, such as without
 * `console.channelLinkPrefix`.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @returns {Promise<string | null>}
 */
const readChannelLink = async (deps, inputs) => {
  const url = consoleLink(
    inputs.consoleUrl,
    "_hot-updater/preview/channel-qr",
    {
      channel: inputs.channel,
    },
  );
  try {
    const response = await deps.fetch(url, { method: "HEAD" });
    const link = response.headers.get("x-hot-updater-channel-link");
    if (response.ok && link) return link;
    deps.log.notice(
      `The Console answered ${response.status} to ${url}, so the comment has no QR code: set console.channelLinkPrefix in the Console's config.`,
    );
  } catch (error) {
    deps.log.notice(
      `The Console's channel QR code is unreachable, so the comment has none: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return null;
};

/**
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {PullRequestEvent} event
 */
export const runPreview = async (deps, inputs, event) => {
  // Preview builds embed the shared preview channel, and each pull request
  // deploys to its own, so closing one deletes its channel.
  await deps.cli(["channel", "set", inputs.previewChannel]);
  /** @type {PlatformPreview[]} */
  const previews = [];
  for (const platform of inputs.platforms) {
    previews.push(
      await deps.log.group(`Preview ${platform}`, () =>
        previewPlatform(deps, inputs, event, platform),
      ),
    );
  }
  const body = renderPreviewComment({
    consoleUrl: inputs.consoleUrl,
    channel: inputs.channel,
    previewChannel: inputs.previewChannel,
    previews,
    channelLink: await readChannelLink(deps, inputs),
    headSha: event.headSha,
    credit: inputs.credit,
  });
  deps.setOutput("previews", JSON.stringify(previews));
  deps.setOutput("comment-body", body);
  if (inputs.comment && deps.github) {
    await upsertComment(deps.github, event.number, body);
  }
  return { previews, body };
};

/**
 * Deletes the closed pull request's channel and its bundles, and says so in
 * its comment. It fails when a native build embeds the channel, which keeps
 * it.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {PullRequestEvent} event
 */
export const runCleanup = async (deps, inputs, event) => {
  const args = ["channel", "delete", inputs.channel, "--yes", "--json"];
  const { code, stdout } = await deps.cli(args, { capture: true });
  const result =
    /** @type {{ deleted: boolean, reason?: string, deletedBundleIds?: string[] }} */ (
      parseJsonOutput(stdout)
    );
  const outcome =
    result.reason === "not_found"
      ? "missing"
      : result.deleted
        ? "deleted"
        : "kept";
  if (outcome !== "kept" && code !== 0) {
    throw new Error(`hot-updater ${args.join(" ")} exited with ${code}.`);
  }
  const body = renderClosedComment({
    channel: inputs.channel,
    outcome,
    deletedBundles: result.deletedBundleIds?.length ?? 0,
    credit: inputs.credit,
  });
  deps.setOutput("comment-body", body);
  // A pull request that was never previewed gets no comment.
  if (inputs.comment && deps.github) {
    const existing = await findComment(deps.github, event.number);
    if (existing) await updateComment(deps.github, existing.id, body);
  }
  if (outcome === "kept") {
    throw new Error(
      `The ${inputs.channel} channel is kept: a native build embeds it. Register preview builds on ${inputs.previewChannel} and deploy each pull request to its own channel.`,
    );
  }
  return { outcome, body };
};

/**
 * Runs the action for a pull request event: a preview while it is open, the
 * cleanup once it is closed. A pull request from a fork, whose run gets no
 * secrets, does nothing.
 *
 * @param {Deps} deps
 * @param {Record<string, string | undefined>} env
 * @param {PullRequestEvent} event
 */
export const runAction = async (deps, env, event) => {
  if (event.fromFork) {
    deps.log.notice(
      "The pull request comes from a fork, whose run gets no secrets: skipping the preview.",
    );
    return { skipped: true };
  }
  const inputs = parseInputs(env, event);
  return inputs.mode === "cleanup"
    ? runCleanup(deps, inputs, event)
    : runPreview(deps, inputs, event);
};
