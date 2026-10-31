// @ts-check

import { runNativeBuild } from "../../native-build/src/nativeBuild.mjs";
import { parseJsonOutput, reportBuildLogs } from "../../shared/cli.mjs";
import {
  deployBundle,
  describeTarget,
  findNativeBuild,
  parseFlag,
  parsePlatforms,
  parseSchemes,
  refreshFingerprint,
  runJson,
  STORES,
} from "../../shared/nativeBuild.mjs";
import {
  consoleLink,
  nativeBuildDownloadLink,
  nativeBuildInstallUrl,
  renderClosedComment,
  renderPreviewComment,
} from "./comment.mjs";
import { findComment, updateComment, upsertComment } from "./github.mjs";

export { parseJsonOutput };

/**
 * @typedef {import("./comment.mjs").Platform} Platform
 * @typedef {import("./comment.mjs").PlatformPreview} PlatformPreview
 *
 * @typedef {object} PreviewOutputs What later steps read of a platform's build.
 * @property {string} installUrl What a person opens: the Console's download
 *   link, or for a simulator build, the `native-build install` command.
 * @property {string | null} downloadUrl The storage's URL of the artifact,
 *   which a step fetches without a Console session; null when it gives none.
 *
 * @typedef {object} Inputs
 * @property {string} consoleUrl
 * @property {Platform[]} platforms
 * @property {Partial<Record<Platform, string>>} schemes The `nativeBuild`
 *   scheme each platform builds.
 * @property {string} channel The pull request's channel, which its native
 *   builds embed and its bundles deploy to.
 * @property {Partial<Record<Platform, "testflight" | "play-internal">>} submits
 *   The store each platform's sandbox build goes to; none previews as before.
 * @property {string | null} testFlightGroup The internal TestFlight group of an
 *   iOS sandbox build.
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
 * @typedef {import("../../shared/nativeBuild.mjs").NativeBuildRow} NativeBuildRow
 */

/**
 * The `<platform>-submit` inputs that are set. Each takes only the platform's
 * internal store path: nothing here can reach store review or another track.
 *
 * @param {(name: string) => string} input
 * @returns {Inputs["submits"]}
 */
const parseSubmits = (input) => {
  /** @type {Inputs["submits"]} */
  const submits = {};
  for (const platform of /** @type {const} */ (["android", "ios"])) {
    const submit = input(`${platform.toUpperCase()}_SUBMIT`);
    if (submit === "") continue;
    if (submit !== STORES[platform].id) {
      throw new Error(
        `${platform}-submit takes ${STORES[platform].id}, not ${submit}: a preview goes no further than internal testing.`,
      );
    }
    submits[platform] = /** @type {any} */ (submit);
  }
  return submits;
};

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
  const consoleUrl = input("CONSOLE_URL");
  if (consoleUrl === "") throw new Error("console-url is required.");
  if (!/^https?:\/\//.test(consoleUrl)) {
    throw new Error("console-url must be the Console's http(s) URL.");
  }

  const mode = input("MODE") || "auto";
  if (mode !== "auto" && mode !== "preview" && mode !== "cleanup") {
    throw new Error("mode must be auto, preview, or cleanup.");
  }

  const platforms = parsePlatforms(input("PLATFORMS") || "android");
  const schemes = parseSchemes(input);

  const channel = input("CHANNEL") || `pr-${event.number}`;

  const submits = parseSubmits(input);
  const testFlightGroup = input("IOS_TESTFLIGHT_GROUP") || null;
  if (testFlightGroup !== null && submits.ios === undefined) {
    throw new Error(
      "ios-testflight-group goes with ios-submit: testflight.\nSet it, or remove ios-testflight-group.",
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
    channel,
    submits,
    testFlightGroup,
    credit: parseFlag(input, "CREDIT", true),
    comment: parseFlag(input, "COMMENT", true),
    mode: resolvedMode,
  };
};

/**
 * What `native-build <platform> --json` prints last: the build, with what
 * its artifact embeds, its record in Hot Updater, and why it has none.
 *
 * @typedef {object} NativeBuildJson
 * @property {{ channel: string, fingerprintHash: string | null, appVersion: string | null }} build
 * @property {NativeBuildRow | null} nativeBuild
 * @property {{ skipped: "debug" | "dry-run" | null }} [registration]
 */

/**
 * The artifact's file name: the last path segment of its storage URI.
 * @param {string} storageUri
 */
const artifactFileName = (storageUri) => {
  const segment = storageUri.split(/[?#]/, 1)[0]?.split("/").at(-1) ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * The storage's URL of a platform's build, read once every platform is done,
 * so a deploy or another platform's native build can't use up its lifetime.
 * `native-build find` finds what a build of the project would match, so a
 * scheme that sets its version at build time can find another build, or none.
 * No URL fails nothing: the preview is deployed, and `native-build download`
 * gets the build.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {PlatformPreview} preview
 * @returns {Promise<string | null>}
 */
const findDownloadUrl = async (
  deps,
  inputs,
  { platform, nativeBuild: { id } },
) => {
  try {
    const found = await findNativeBuild(deps, {
      platform,
      scheme: /** @type {string} */ (inputs.schemes[platform]),
      // A sandbox scheme's channel is its own, which `find` refuses to be told.
      channel: inputs.submits[platform] ? null : inputs.channel,
    });
    if (found.nativeBuild?.id === id) return found.downloadUrl ?? null;
    deps.log.notice(
      `No ${platform}-download-url: native-build find didn't match ${id}.`,
    );
  } catch (error) {
    deps.log.notice(
      `No ${platform}-download-url: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return null;
};

/**
 * Finds or makes a store build of a sandbox scheme, which every pull request
 * with its native code shares, on the scheme's own channel. A build the store
 * still offers needs no upload. Anything else goes through `native-build
 * --submit`, which reuses a build the store never took; one the store no longer
 * offers, or that is about to expire, gets a new build with a new number.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {PullRequestEvent} event
 * @param {Platform} platform
 * @param {"testflight" | "play-internal"} submit
 */
const findOrSubmitStoreBuild = async (
  deps,
  inputs,
  event,
  platform,
  submit,
) => {
  const scheme = /** @type {string} */ (inputs.schemes[platform]);
  const sandboxChannel = `sandbox-${scheme}`;
  const found = await findNativeBuild(deps, {
    platform,
    scheme,
    storeStatus: true,
  });
  if (found.channel !== sandboxChannel) {
    throw new Error(
      `${platform}-submit takes a sandbox scheme, and ${scheme} isn't one.\nSet sandbox: true on it, or remove ${platform}-submit.`,
    );
  }
  if (
    found.nativeBuild !== null &&
    found.nativeBuild.submitted_to === submit &&
    found.store?.reusable !== false
  ) {
    deps.log.info(
      `Reusing ${platform} native build ${found.nativeBuild.id} on ${STORES[platform].name} (${describeTarget(found)}).`,
    );
    if (!found.store?.state) {
      deps.log.notice(
        `No ${platform}-store-state: ${STORES[platform].name} couldn't be read, so the comment shows only what the build's record says.`,
      );
    }
    await refreshFingerprint(deps, found);
    return {
      build: found.nativeBuild,
      target: found,
      built: false,
      store: found.store ?? null,
    };
  }
  const noLongerOffered = found.nativeBuild?.submitted_to === submit;
  deps.log.info(
    noLongerOffered
      ? `Building ${platform}: ${STORES[platform].name} no longer offers ${found.nativeBuild?.id} (${found.store?.state ?? "expiring"}).`
      : `Building ${platform} for ${STORES[platform].name}: no build there has ${describeTarget(found)}.`,
  );
  const built = await runNativeBuild(
    deps,
    {
      platform,
      scheme,
      submit,
      noCache: noLongerOffered,
      extraArgs:
        platform === "ios"
          ? [
              ...(inputs.testFlightGroup === null
                ? []
                : ["--testflight-group", inputs.testFlightGroup]),
              "--what-to-test",
              `Native build for #${event.number}. Pull requests with the same native code reuse it.`,
            ]
          : [],
    },
    { buildLogOutput: `${platform}-build-log` },
  );
  if (built.build.channel !== sandboxChannel) {
    throw new Error(
      `native-build ${platform} built a native build that embeds the ${built.build.channel} channel, not ${sandboxChannel}.`,
    );
  }
  if (built.nativeBuild === null) {
    throw new Error(`native-build ${platform} tracked no native build.`);
  }
  const { skipped, existing, store } = built.submission;
  // The store matched the number, not this artifact: never show it as this one.
  if (skipped === "already-submitted" && existing?.source === "store") {
    throw new Error(
      `${STORES[platform].name} already has ${existing.version ?? "this build number"}, which may be another build. Push again for a new number.`,
    );
  }
  return {
    build: /** @type {NativeBuildRow} */ (built.nativeBuild),
    target: {
      fingerprintHash: built.build.fingerprintHash,
      appVersion: built.build.appVersion,
    },
    built: true,
    store: store ?? {
      destination: submit,
      url: null,
      version: existing?.version ?? null,
      state: null,
      expiresAtMs: null,
      reusable: true,
    },
  };
};

/**
 * Deploys one platform's bundle to the pull request's channel, after
 * building and registering a native build that embeds the channel when the
 * registry has none for the project's fingerprint, or app version, there.
 * The build's default channel is the pull request's, so its first update
 * check finds the pull request's bundle.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {PullRequestEvent} event
 * @param {Platform} platform
 * @returns {Promise<PlatformPreview & { installUrl: string }>}
 */
const previewPlatform = async (deps, inputs, event, platform) => {
  const scheme = /** @type {string} */ (inputs.schemes[platform]);
  const submit = inputs.submits[platform];
  if (submit) {
    const { build, target, built, store } = await findOrSubmitStoreBuild(
      deps,
      inputs,
      event,
      platform,
      submit,
    );
    const bundleId = await deployBundle(deps, {
      platform,
      channel: inputs.channel,
      target,
      message: `#${event.number} ${event.title}`,
    });
    const nativeBuild = {
      id: build.id,
      artifactKind: build.artifact_kind,
      fileName: artifactFileName(build.artifact_storage_uri),
    };
    return {
      platform,
      target: {
        fingerprintHash: target.fingerprintHash,
        appVersion: target.appVersion,
      },
      nativeBuild,
      built,
      bundleId,
      store,
      installUrl:
        store?.url ?? nativeBuildInstallUrl(inputs.consoleUrl, nativeBuild),
    };
  }
  const found = await findNativeBuild(deps, {
    platform,
    scheme,
    channel: inputs.channel,
  });
  /** @type {import("../../shared/nativeBuild.mjs").BuildTarget} */
  let target = {
    fingerprintHash: found.fingerprintHash,
    appVersion: found.appVersion,
  };
  /** @type {PlatformPreview["nativeBuild"]} */
  let nativeBuild;
  const built = found.nativeBuild === null;
  if (found.nativeBuild === null) {
    deps.log.info(
      `Building ${platform}: no native build on ${inputs.channel} has ${describeTarget(found)}.`,
    );
    const since = Date.now();
    // Every native build is tracked, so the preview can install it.
    const registered = /** @type {NativeBuildJson} */ (
      await runJson(deps, [
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
    if (registered.build.channel !== inputs.channel) {
      throw new Error(
        `native-build ${platform} built a native build that embeds the ${registered.build.channel} channel, not ${inputs.channel}. An Expo project sets the channel in the @hot-updater/expo config plugin, such as from a PREVIEW_CHANNEL variable the job sets to ${inputs.channel}.`,
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
      fileName: artifactFileName(registered.nativeBuild.artifact_storage_uri),
    };
  } else {
    deps.log.info(
      `Reusing ${platform} native build ${found.nativeBuild.id} (${describeTarget(found)}).`,
    );
    nativeBuild = {
      id: found.nativeBuild.id,
      artifactKind: found.nativeBuild.artifact_kind,
      fileName: artifactFileName(found.nativeBuild.artifact_storage_uri),
    };
    await refreshFingerprint(deps, found);
  }

  const bundleId = await deployBundle(deps, {
    platform,
    channel: inputs.channel,
    target,
    message: `#${event.number} ${event.title}`,
  });

  return {
    platform,
    target,
    nativeBuild,
    built,
    bundleId,
    installUrl: nativeBuildInstallUrl(inputs.consoleUrl, nativeBuild),
  };
};

/**
 * Whether the comment can show the Console's QR code of an APK's download:
 * GitHub fetches a comment's images from the internet, so the runner checks
 * that the Console answers with the download URL under its own address. A
 * private Console, such as one on a VPN, is out of reach, and the comment
 * keeps only the links.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {string} id
 */
const servesDownloadQr = async (deps, inputs, id) => {
  const url = consoleLink(inputs.consoleUrl, "_hot-updater/native-builds/qr", {
    build: id,
  });
  const expected = nativeBuildDownloadLink(inputs.consoleUrl, id);
  let cause;
  try {
    const response = await deps.fetch(url, { method: "HEAD" });
    const downloadUrl = response.headers.get("x-hot-updater-download-url");
    if (response.ok && downloadUrl === expected) return true;
    cause = response.ok
      ? `the QR code at ${url} holds ${downloadUrl}, not ${expected}`
      : `the Console answered ${response.status} to ${url}`;
  } catch (error) {
    cause = `the Console is unreachable from the runner (${error instanceof Error ? error.message : String(error)})`;
  }
  deps.log.notice(`No QR code in the comment: ${cause}.`);
  return false;
};

/**
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {PullRequestEvent} event
 */
export const runPreview = async (deps, inputs, event) => {
  // The pull request's native builds embed its channel, so their first
  // update check finds its bundle.
  await deps.cli(["channel", "set", inputs.channel]);
  /** @type {(PlatformPreview & { installUrl: string })[]} */
  const previews = [];
  for (const platform of inputs.platforms) {
    previews.push(
      await deps.log.group(`Preview ${platform}`, () =>
        previewPlatform(deps, inputs, event, platform),
      ),
    );
  }
  /** @type {string[]} */
  const qrCodes = [];
  for (const { nativeBuild } of previews) {
    if (
      nativeBuild.artifactKind === "apk" &&
      (await servesDownloadQr(deps, inputs, nativeBuild.id))
    ) {
      qrCodes.push(nativeBuild.id);
    }
  }
  const body = renderPreviewComment({
    consoleUrl: inputs.consoleUrl,
    channel: inputs.channel,
    previews,
    qrCodes,
    headSha: event.headSha,
    credit: inputs.credit,
  });
  /** @type {(PlatformPreview & PreviewOutputs)[]} */
  const outputs = [];
  for (const preview of previews) {
    outputs.push({
      ...preview,
      downloadUrl: await findDownloadUrl(deps, inputs, preview),
    });
  }
  deps.setOutput("previews", JSON.stringify(outputs));
  for (const { platform, installUrl, downloadUrl, store } of outputs) {
    deps.setOutput(`${platform}-install-url`, installUrl);
    deps.setOutput(`${platform}-download-url`, downloadUrl ?? "");
    if (store) {
      deps.setOutput(`${platform}-store-url`, store.url ?? "");
      deps.setOutput(`${platform}-store-state`, store.state ?? "");
    }
  }
  deps.setOutput("comment-body", body);
  if (inputs.comment && deps.github) {
    await upsertComment(deps.github, event.number, body);
  }
  return { previews: outputs, body };
};

/**
 * Deletes the closed pull request's channel with its bundles and the native
 * builds that embed it, each with its artifact, and says so in its comment.
 * It fails when the channel is kept, as when a bundle or a build is added to
 * it meanwhile.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {PullRequestEvent} event
 */
export const runCleanup = async (deps, inputs, event) => {
  const args = [
    "channel",
    "delete",
    inputs.channel,
    "--native-builds",
    "--yes",
    "--json",
  ];
  const { code, stdout } = await deps.cli(args, { capture: true });
  const result =
    /** @type {{ deleted: boolean, reason?: string, deletedBundleIds?: string[], deletedNativeBuildIds?: string[] }} */ (
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
    deletedNativeBuilds: result.deletedNativeBuildIds?.length ?? 0,
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
      `The ${inputs.channel} channel is kept: a bundle or a native build was added to it while the cleanup ran. Run the cleanup again.`,
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
      "Skipping the preview: a pull request from a fork gets no secrets.",
    );
    return { skipped: true };
  }
  const inputs = parseInputs(env, event);
  return inputs.mode === "cleanup"
    ? runCleanup(deps, inputs, event)
    : runPreview(deps, inputs, event);
};
