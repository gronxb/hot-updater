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
  nativeBuildInstallUrl,
  previewLink,
  qrCodeValues,
  renderClosedComment,
  renderPreviewComment,
  simulatorOpens,
} from "./comment.mjs";
import {
  createComment,
  findComment,
  pullRequestHead,
  updateComment,
  upsertComment,
} from "./github.mjs";
import { removeQrCodes, writeQrCodes } from "./qrBranch.mjs";

export { parseJsonOutput };

/**
 * @typedef {import("./comment.mjs").Platform} Platform
 * @typedef {import("./comment.mjs").PlatformPreview} PlatformPreview
 *
 * @typedef {object} PreviewOutputs What later steps read of a platform's build.
 * @property {string} installUrl What a person opens: the store's page of a
 *   store build, the Console's build page for an `.ipa`, where an iPhone
 *   installs it, the Console's download link for an Android build, or for a
 *   simulator build, the `native-build install` command.
 * @property {string | null} downloadUrl The storage's URL of the artifact,
 *   which a step fetches without a Console session; null when it gives none.
 *
 * @typedef {object} Inputs
 * @property {string} consoleUrl
 * @property {Platform[]} platforms
 * @property {Partial<Record<Platform, string[]>>} schemes The `nativeBuild`
 *   schemes each platform builds, in order: several are targets of the same
 *   native code, such as an ad hoc and a Simulator scheme.
 * @property {string} channel The pull request's channel, which its native
 *   builds embed and its bundles deploy to.
 * @property {Partial<Record<Platform, "testflight" | "play-internal">>} submits
 *   The store each platform's sandbox build goes to; none previews as before.
 * @property {string | null} testFlightGroup The internal TestFlight group of an
 *   iOS sandbox build.
 * @property {boolean} credit
 * @property {boolean} comment Whether to write the pull request comment.
 * @property {boolean} deploy Whether to deploy each platform's bundle. A
 *   lane that only builds, such as each iOS lane beside the job that deploys
 *   the iOS bundle after both, sets it to false.
 * @property {boolean} build Whether a scheme with no native build builds
 *   one. A job that deploys against the builds its lanes reported in
 *   `results` sets it to false: it then compiles nothing and looks up no
 *   other build.
 * @property {Map<string, PlatformPreview & { scheme?: string }> | null} reported
 *   With `build: false`, the build each lane reported, by platform and scheme.
 * @property {string} results With `comment`, each lane's line: its job's
 *   name, its conclusion, and its `result` output.
 * @property {"preview" | "cleanup" | "comment"} mode
 *
 * @typedef {object} PullRequestEvent
 * @property {string} action
 * @property {boolean} fromFork Whether the pull request comes from a fork,
 *   whose workflow runs get no secrets.
 * @property {number} number
 * @property {string} title
 * @property {string} commitSha The commit the run deploys: what the app's
 *   directory has checked out.
 * @property {string | null} [headSha] The pull request's head when the event
 *   came, which a comment job checks is still its head before writing.
 * @property {string | null} repositoryUrl The repository's web URL, which
 *   the comment links the commit under.
 * @property {string | null} runUrl The workflow run's page, which the comment
 *   links a platform that failed to.
 *
 * @typedef {object} Deps
 * @property {(args: string[], options?: { capture?: boolean }) => Promise<{ code: number, stdout: string }>} cli
 *   Runs the project's hot-updater CLI. Without `capture`, it prints the
 *   command's output and throws when the command fails; with it, it returns
 *   the output and the exit code.
 * @property {import("../../shared/cli.mjs").BuildLogs} buildLogs
 * @property {import("./github.mjs").GitHubContext | null} github
 * @property {(name: string, value: string) => void} setOutput
 * @property {{ info: (message: string) => void, notice: (message: string) => void, error: (message: string) => void, group: <T>(name: string, run: () => Promise<T>) => Promise<T> }} log
 *
 * @typedef {import("../../shared/nativeBuild.mjs").NativeBuildRow} NativeBuildRow
 */

/**
 * The repository's web URL, which the comment links the commit under: from
 * the server the workflow runs on, such as GitHub Enterprise Server's, else
 * from the event.
 * @param {Record<string, string | undefined>} env
 * @param {{ repository?: { html_url?: string } } | undefined} payload
 * @returns {string | null}
 */
export const repositoryUrlOf = (env, payload) => {
  const serverUrl = env["GITHUB_SERVER_URL"];
  const repository = env["GITHUB_REPOSITORY"];
  return serverUrl && repository
    ? `${serverUrl.replace(/\/+$/, "")}/${repository}`
    : (payload?.repository?.html_url ?? null);
};

/**
 * The workflow run's page, or none without the repository's URL or the run.
 * @param {Record<string, string | undefined>} env
 * @param {{ repository?: { html_url?: string } } | undefined} payload
 */
export const runUrlOf = (env, payload) => {
  const repositoryUrl = repositoryUrlOf(env, payload);
  const runId = env["GITHUB_RUN_ID"];
  return repositoryUrl && runId
    ? `${repositoryUrl}/actions/runs/${encodeURIComponent(runId)}`
    : null;
};

/**
 * The deploy message of a pull request's bundle, which the sandbox app shows
 * on one line: the commit first, so the line's ellipsis never cuts it.
 * @param {PullRequestEvent} event
 */
export const deployMessage = ({ commitSha, number, title }) =>
  `${commitSha.slice(0, 7)} · #${number} ${title}`;

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
  if (
    mode !== "auto" &&
    mode !== "preview" &&
    mode !== "cleanup" &&
    mode !== "comment"
  ) {
    throw new Error("mode must be auto, preview, cleanup, or comment.");
  }
  const results = input("RESULTS");
  if (mode === "comment" && results === "") {
    throw new Error(
      "mode: comment needs results: a line for each lane's job, such as ${{ needs.android.result }} and ${{ needs.android.outputs.result }} after its name.",
    );
  }

  const platforms = parsePlatforms(input("PLATFORMS") || "android");
  // Comma-separated, so a scheme's name keeps its spaces.
  /** @type {Inputs["schemes"]} */
  const schemes = Object.fromEntries(
    Object.entries(parseSchemes(input)).map(([platform, value]) => [
      platform,
      value
        .split(",")
        .map((scheme) => scheme.trim())
        .filter((scheme) => scheme !== ""),
    ]),
  );

  const channel = input("CHANNEL") || `pr-${event.number}`;

  const submits = parseSubmits(input);
  for (const platform of /** @type {const} */ (["android", "ios"])) {
    if (submits[platform] && (schemes[platform]?.length ?? 0) > 1) {
      throw new Error(
        `${platform}-submit takes one ${platform}-scheme.\nList one scheme, or remove ${platform}-submit.`,
      );
    }
  }
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
  const build = parseFlag(input, "BUILD", true);
  if (resolvedMode === "preview" && !build && results === "") {
    throw new Error(
      "build: false takes results: the result line of each job that builds, which this job deploys against.",
    );
  }
  if (resolvedMode === "preview") {
    for (const platform of platforms) {
      if (!schemes[platform]?.length) {
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
    deploy: parseFlag(input, "DEPLOY", true),
    build,
    reported: build ? null : reportedBuilds(results),
    results,
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
 * @property {{ expiresAtMs: number | null } | null} [ipa] When an ad hoc
 *   `.ipa`'s profile expires; null for any other artifact.
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
 * @param {string} scheme The scheme that previewed it.
 * @returns {Promise<string | null>}
 */
const findDownloadUrl = async (
  deps,
  inputs,
  { platform, nativeBuild: { id } },
  scheme,
) => {
  try {
    // A sandbox scheme's lookup finds its build on any channel.
    const found = await findNativeBuild(deps, {
      platform,
      scheme,
      channel: inputs.channel,
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
 * with its native code shares, whichever channel it embeds. A build the store
 * still offers needs no upload, and joins the requested internal group, which
 * may not be the one it was uploaded for. Anything else goes through `native-build
 * --submit`, which reuses a build the store never took; one the store no longer
 * offers, or that is about to expire, gets a new build with a new number.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {PullRequestEvent} event
 * @param {Platform} platform
 * @param {string} scheme
 * @param {"testflight" | "play-internal"} submit
 */
const findOrSubmitStoreBuild = async (
  deps,
  inputs,
  event,
  platform,
  scheme,
  submit,
) => {
  const group = platform === "ios" ? inputs.testFlightGroup : null;
  // With a group to apply, that one command reads the store's word too.
  const found = await findNativeBuild(deps, {
    platform,
    scheme,
    storeStatus: group === null,
  });
  // `find` describes a sandbox scheme's builds with `sandbox`, and only its.
  if (found.sandbox === undefined) {
    throw new Error(
      `${platform}-submit takes a sandbox scheme, and ${scheme} isn't one.\nSet sandbox: true on it, or remove ${platform}-submit.`,
    );
  }
  const submitted =
    found.nativeBuild !== null && found.nativeBuild.submitted_to === submit
      ? found.nativeBuild
      : null;
  const foundStore =
    submitted !== null && group !== null
      ? /** @type {import("../../shared/nativeBuild.mjs").StoreStatus & { group: string }} */ (
          await runJson(deps, [
            "native-build",
            "testflight-group",
            submitted.id,
            group,
            "--scheme",
            scheme,
            "--json",
          ])
        )
      : /** @type {(import("../../shared/nativeBuild.mjs").StoreStatus & { group?: string }) | null} */ (
          found.store ?? null
        );
  if (submitted !== null && foundStore?.reusable !== false) {
    deps.log.info(
      `Reusing ${platform} native build ${submitted.id} on ${STORES[platform].name} (${describeTarget(found)}).`,
    );
    if (foundStore?.group === "pending") {
      deps.log.notice(
        `${group} doesn't have build ${submitted.id} yet: App Store Connect is still processing it. The next run adds it.`,
      );
    }
    if (!foundStore?.state) {
      deps.log.notice(
        `No ${platform}-store-state: ${STORES[platform].name} couldn't be read, so the comment shows only what the build's record says.`,
      );
    }
    await refreshFingerprint(deps, found);
    return {
      build: submitted,
      target: found,
      built: false,
      store: foundStore,
      sandbox: found.sandbox,
    };
  }
  const noLongerOffered = submitted !== null;
  deps.log.info(
    noLongerOffered
      ? `Building ${platform}: ${STORES[platform].name} no longer offers ${submitted.id} (${foundStore?.state ?? "expiring"}).`
      : `Building ${platform} for ${STORES[platform].name}: no build there has ${describeTarget(found)}.`,
  );
  const built = await runNativeBuild(
    deps,
    {
      platform,
      scheme,
      submit,
      noCache: noLongerOffered,
      extraArgs: [
        "--channel",
        inputs.channel,
        ...(platform === "ios"
          ? [
              ...(inputs.testFlightGroup === null
                ? []
                : ["--testflight-group", inputs.testFlightGroup]),
              "--what-to-test",
              `Native build for #${event.number}. Pull requests with the same native code reuse it.`,
            ]
          : []),
      ],
    },
    { buildLogOutput: `${platform}-build-log` },
  );
  assertEmbedsChannel(platform, built.build.channel, inputs.channel);
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
    sandbox: found.sandbox,
  };
};

/**
 * What a sandbox build adds to its preview: the link a QR code holds, of the
 * URL scheme the build registered: its record's, or `find`'s, which also
 * answers for a build that registered before the record. A link names a
 * fingerprint, so a build matched by app version has none, and its platform.
 *
 * @param {Inputs} inputs
 * @param {Platform} platform
 * @param {{ appId: string, urlScheme: string, channel: string | null } | undefined} sandbox
 * @param {import("../../shared/nativeBuild.mjs").BuildTarget} target
 * @param {NativeBuildRow} build
 * @param {boolean} built Whether this run built it.
 * @returns {{ sandbox?: import("./comment.mjs").SandboxPreview }}
 */
const sandboxOf = (
  inputs,
  platform,
  sandbox,
  { fingerprintHash },
  build,
  built,
) => {
  if (sandbox === undefined) return {};
  const urlScheme = build.sandbox_url_scheme ?? sandbox.urlScheme;
  return {
    sandbox: {
      appId: sandbox.appId,
      urlScheme,
      // Another pull request's channel, when it made the reused build.
      fromChannel:
        !built && sandbox.channel !== null && sandbox.channel !== inputs.channel
          ? sandbox.channel
          : null,
      link:
        fingerprintHash === null
          ? null
          : previewLink({
              urlScheme,
              channel: inputs.channel,
              fingerprintHash,
              platform,
            }),
      minBundleId: build.min_bundle_id ?? null,
    },
  };
};

/**
 * A scheme's native build, found or built and tracked, before its bundle is
 * deployed: a build this run makes has a built-in bundle newer than any
 * bundle deployed before it, so every scheme of a platform resolves first.
 *
 * @typedef {object} ResolvedScheme
 * @property {string} scheme
 * @property {NativeBuildRow} build
 * @property {import("../../shared/nativeBuild.mjs").BuildTarget} target What
 *   the artifact embeds, which the bundle deploys to.
 * @property {boolean} built Whether this run built it.
 * @property {{ appId: string, urlScheme: string, channel: string | null } | undefined} sandbox
 *   `find`'s word on a sandbox scheme.
 * @property {number | null} [expiresAtMs] When an ad hoc `.ipa`'s profile
 *   expires, which a later job with `build: false` checks.
 * @property {PlatformPreview & { scheme?: string }} [reported] With
 *   `build: false`, the build its lane reported, which stands for all of it.
 */

/**
 * Finds the scheme's native build that embeds the pull request's channel,
 * or a sandbox scheme's on any channel, or builds and tracks one.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {Platform} platform
 * @param {string} scheme
 * @returns {Promise<ResolvedScheme>}
 */
const resolveScheme = async (deps, inputs, platform, scheme) => {
  if (inputs.reported !== null) {
    const reported = inputs.reported.get(`${platform}:${scheme}`);
    if (reported === undefined) {
      throw new Error(
        `The job that builds ${scheme} reported no ${platform} build, and this job doesn't build: see that job.`,
      );
    }
    // A result kept from an earlier attempt can outlive its .ipa's profile,
    // and one that doesn't say when it expires can't be trusted to have not.
    const { expiresAtMs, artifactKind, id } = reported.nativeBuild;
    if (
      artifactKind === "ipa" &&
      !reported.store &&
      expiresAtMs === undefined
    ) {
      throw new Error(
        `The ${scheme} build ${id} has no profile expiry in its job's result, and this job doesn't build: run that job again.`,
      );
    }
    if (expiresAtMs !== undefined && expiresAtMs <= Date.now()) {
      throw new Error(
        `The ${scheme} build ${reported.nativeBuild.id}'s profile expired at ${new Date(expiresAtMs).toISOString()}, after its job reported it, and this job doesn't build: run that job again.`,
      );
    }
    await refreshFingerprint(deps, reported.target);
    return {
      scheme,
      build: /** @type {NativeBuildRow} */ (/** @type {unknown} */ (null)),
      target: reported.target,
      built: reported.built,
      sandbox: undefined,
      reported,
    };
  }
  // With no channel, `find` answers for what the project embeds, which
  // `channel set` made the pull request's, and a sandbox scheme's build on
  // any channel.
  const found = await findNativeBuild(deps, { platform, scheme });
  // A new sandbox build is one more build of the pull request's channel; a
  // found one may embed another pull request's.
  const resolved = await resolveNativeBuild(deps, inputs, {
    platform,
    scheme,
    // The build embeds the pull request's channel, whatever the project's.
    found:
      found.sandbox !== undefined || found.channel === inputs.channel
        ? found
        : await findNativeBuild(deps, {
            platform,
            scheme,
            channel: inputs.channel,
          }),
  });
  return { scheme, ...resolved, sandbox: found.sandbox };
};

/**
 * A resolved scheme's preview, once its bundle is deployed.
 *
 * @param {Inputs} inputs
 * @param {Platform} platform
 * @param {ResolvedScheme} resolved
 * @param {string | null} bundleId Null when the run deploys no bundle.
 * @returns {PlatformPreview & { installUrl: string }}
 */
const previewOf = (
  inputs,
  platform,
  { build, target, built, sandbox, reported, expiresAtMs },
  bundleId,
) => {
  if (reported !== undefined) {
    return {
      ...reported,
      bundleId,
      // A store build installs from its store, as the store path says.
      installUrl: reported.store
        ? (reported.store.url ??
          nativeBuildInstallUrl(inputs.consoleUrl, reported.nativeBuild))
        : nativeBuildInstallUrl(
            inputs.consoleUrl,
            reported.nativeBuild,
            simulatorOpens(reported, inputs.channel),
          ),
    };
  }
  const nativeBuild = {
    id: build.id,
    artifactKind: build.artifact_kind,
    fileName: artifactFileName(build.artifact_storage_uri),
    ...(typeof expiresAtMs === "number" ? { expiresAtMs } : {}),
  };
  const sandboxPreview = sandboxOf(
    inputs,
    platform,
    sandbox,
    target,
    build,
    built,
  );
  return {
    platform,
    target,
    nativeBuild,
    built,
    bundleId,
    installUrl: nativeBuildInstallUrl(
      inputs.consoleUrl,
      nativeBuild,
      simulatorOpens({ nativeBuild, ...sandboxPreview }, inputs.channel),
    ),
    ...sandboxPreview,
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
 * @param {string} scheme
 * @param {() => void} onDeployed Runs once the bundle is on the channel.
 * @returns {Promise<PlatformPreview & { installUrl: string }>}
 */
const previewPlatform = async (
  deps,
  inputs,
  event,
  platform,
  scheme,
  onDeployed,
) => {
  // A job with `build: false` deploys against its lanes' builds, a store
  // build's too, and runs no store command.
  const submit =
    inputs.reported === null ? inputs.submits[platform] : undefined;
  if (submit) {
    const { build, target, built, store, sandbox } =
      await findOrSubmitStoreBuild(
        deps,
        inputs,
        event,
        platform,
        scheme,
        submit,
      );
    const bundleId = inputs.deploy
      ? await deployBundle(deps, {
          platform,
          channel: inputs.channel,
          target,
          message: deployMessage(event),
          onDeployed,
        })
      : null;
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
      ...sandboxOf(inputs, platform, sandbox, target, build, built),
      installUrl:
        store?.url ?? nativeBuildInstallUrl(inputs.consoleUrl, nativeBuild),
    };
  }
  const resolved = await resolveScheme(deps, inputs, platform, scheme);
  const bundleId = inputs.deploy
    ? await deployBundle(deps, {
        platform,
        channel: inputs.channel,
        target: resolved.target,
        message: deployMessage(event),
        onDeployed,
      })
    : null;
  return previewOf(inputs, platform, resolved, bundleId);
};

/**
 * Previews several schemes of one platform, targets of the same native code
 * such as an ad hoc `.ipa` and a Simulator `.app`: each is found or built
 * first, then the platform's one bundle deploys to the target they share.
 * A scheme that fails leaves the others; schemes of different native code
 * deploy nothing, since one deploy targets one fingerprint or app version.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {PullRequestEvent} event
 * @param {Platform} platform
 * @param {string[]} schemes
 * @param {() => void} onDeployed
 * @returns {Promise<{ previews: (PlatformPreview & { installUrl: string, scheme: string })[], failures: { scheme?: string, error: unknown, deployed?: boolean }[] }>}
 *   A failure's `deployed` says whether its bundle reached the channel: a
 *   scheme that failed before the deploy has none.
 */
const previewSchemes = async (
  deps,
  inputs,
  event,
  platform,
  schemes,
  onDeployed,
) => {
  /** @type {ResolvedScheme[]} */
  const resolved = [];
  /** @type {{ scheme?: string, error: unknown, deployed?: boolean }[]} */
  const failures = [];
  for (const scheme of schemes) {
    try {
      resolved.push(await resolveScheme(deps, inputs, platform, scheme));
    } catch (error) {
      failures.push({ scheme, error, deployed: false });
    }
  }
  const targets = new Set(
    resolved.map(({ target }) =>
      target.fingerprintHash === null
        ? `app version ${target.appVersion}`
        : `fingerprint ${target.fingerprintHash}`,
    ),
  );
  if (targets.size > 1) {
    failures.push({
      error: new Error(
        `The ${platform}-scheme schemes build different native code: ${resolved
          .map(({ scheme, target }) => `${scheme} (${describeTarget(target)})`)
          .join(", ")}. List schemes of one native code.`,
      ),
    });
    return { previews: [], failures };
  }
  const [first] = resolved;
  if (first === undefined) return { previews: [], failures };
  if (!inputs.deploy) {
    return {
      previews: resolved.map((scheme) => ({
        scheme: scheme.scheme,
        ...previewOf(inputs, platform, scheme, null),
      })),
      failures,
    };
  }
  let deployed = false;
  try {
    const bundleId = await deployBundle(deps, {
      platform,
      channel: inputs.channel,
      target: first.target,
      message: deployMessage(event),
      onDeployed: () => {
        deployed = true;
        onDeployed();
      },
    });
    return {
      previews: resolved.map((scheme) => ({
        scheme: scheme.scheme,
        ...previewOf(inputs, platform, scheme, bundleId),
      })),
      failures,
    };
  } catch (error) {
    return {
      previews: [],
      failures: [
        ...failures,
        ...resolved.map(({ scheme }) => ({ scheme, error, deployed })),
      ],
    };
  }
};

/**
 * The build each lane reported, by platform and scheme, which a job with
 * `build: false` deploys against. A lane that failed or was skipped reports
 * none, and its scheme stays failed.
 *
 * @param {string} results
 * @returns {Map<string, PlatformPreview & { scheme?: string }>}
 */
const reportedBuilds = (results) => {
  /** @type {Map<string, PlatformPreview & { scheme?: string }>} */
  const builds = new Map();
  for (const { result } of parseLanes(results)) {
    for (const preview of result?.previews ?? []) {
      if (preview.scheme !== undefined) {
        builds.set(`${preview.platform}:${preview.scheme}`, preview);
      }
    }
  }
  return builds;
};

/**
 * Refuses a native build this run made that embeds another channel than the
 * pull request's, before anything is deployed: every build a preview makes,
 * a sandbox build too, is told the pull request's channel with `--channel`,
 * and is one more build of it.
 *
 * @param {Platform} platform
 * @param {string} embedded
 * @param {string} channel The pull request's channel.
 */
const assertEmbedsChannel = (platform, embedded, channel) => {
  if (embedded !== channel) {
    throw new Error(
      `native-build ${platform} built a native build that embeds the ${embedded} channel, not ${channel}.`,
    );
  }
};

/**
 * Finds, or builds and tracks, a native build of the scheme that embeds the
 * pull request's channel: a sandbox scheme's found build may embed another
 * pull request's. A found ad hoc `.ipa` that lacks a device approved since
 * it was built, or whose profile expired or can't be read, is built again
 * past the cache, which would hand back the same `.ipa`.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {{ platform: Platform, scheme: string, found: import("../../shared/nativeBuild.mjs").NativeBuildFindResult }} options
 * @returns {Promise<{ build: NativeBuildRow, target: import("../../shared/nativeBuild.mjs").BuildTarget, built: boolean, expiresAtMs: number | null }>}
 */
const resolveNativeBuild = async (
  deps,
  inputs,
  { platform, scheme, found },
) => {
  /** @type {import("../../shared/nativeBuild.mjs").BuildTarget} */
  let target = {
    fingerprintHash: found.fingerprintHash,
    appVersion: found.appVersion,
  };
  /** @type {NativeBuildRow} */
  let build;
  /** When an ad hoc `.ipa`'s profile expires, as the CLI read it. */
  let expiresAtMs = null;
  const devices = found.iosDevices;
  if (devices && devices.waiting.length > 0) {
    deps.log.notice(
      `The ${platform} build doesn't have ${devices.waiting
        .map(({ name, reason }) => `${name} (${reason})`)
        .join(", ")}. The next preview builds again once a build can add them.`,
    );
  }
  const rebuild = found.nativeBuild !== null && devices?.reusable === false;
  const built = found.nativeBuild === null || rebuild;
  if (found.nativeBuild === null || rebuild) {
    deps.log.info(
      rebuild
        ? `Building ${platform}: native build ${found.nativeBuild?.id} ${
            devices?.reason === "missing"
              ? `lacks ${devices.missing.join(", ")}`
              : devices?.reason === "expired"
                ? "has an expired profile"
                : "has a profile that can't be read"
          }.`
        : `Building ${platform}: no native build on ${inputs.channel} has ${describeTarget(found)}.`,
    );
    const since = Date.now();
    // Every native build is tracked, so the preview can install it.
    const registered = /** @type {NativeBuildJson} */ (
      await runJson(deps, [
        "native-build",
        platform,
        "--scheme",
        scheme,
        // The channel the build embeds, whatever an Expo config plugin sets.
        "--channel",
        inputs.channel,
        ...(rebuild ? ["--no-cache"] : []),
        "--json",
      ]).catch((error) => {
        reportBuildLogs(deps, `${platform}-build-log`, since);
        throw error;
      })
    );
    assertEmbedsChannel(platform, registered.build.channel, inputs.channel);
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
    build = registered.nativeBuild;
    expiresAtMs = registered.ipa?.expiresAtMs ?? null;
  } else {
    deps.log.info(
      found.sandbox?.channel && found.sandbox.channel !== inputs.channel
        ? `Reusing ${platform} native build ${found.nativeBuild.id} from ${found.sandbox.channel} (${describeTarget(found)}).`
        : `Reusing ${platform} native build ${found.nativeBuild.id} (${describeTarget(found)}).`,
    );
    build = found.nativeBuild;
    expiresAtMs = devices?.expiresAtMs ?? null;
    await refreshFingerprint(deps, found);
  }

  return { build, target, built, expiresAtMs };
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
  /** The scheme each preview was made with. */
  const schemeOf = new Map();
  /** @type {{ platform: Platform, scheme?: string, error: unknown, deployed: boolean }[]} */
  const failures = [];
  // Each platform deploys on its own, so the comment names this run's
  // commit only beside the platforms that deployed it.
  for (const platform of inputs.platforms) {
    const schemes = /** @type {string[]} */ (inputs.schemes[platform]);
    let deployed = false;
    const onDeployed = () => {
      deployed = true;
    };
    /** @type {{ scheme?: string, error: unknown, deployed?: boolean }[]} */
    let failed = [];
    const [only] = schemes;
    if (schemes.length === 1 && only !== undefined) {
      try {
        const preview = await deps.log.group(`Preview ${platform}`, () =>
          previewPlatform(deps, inputs, event, platform, only, onDeployed),
        );
        previews.push(preview);
        schemeOf.set(preview, only);
      } catch (error) {
        failed = [{ error }];
      }
    } else {
      // Each failed scheme's build log, set once, so none hides another's.
      const logName = `${platform}-build-log`;
      /** @type {string[]} */
      const logs = [];
      const result = await deps.log.group(`Preview ${platform}`, () =>
        previewSchemes(
          {
            ...deps,
            setOutput: (name, value) =>
              name === logName ? logs.push(value) : deps.setOutput(name, value),
          },
          inputs,
          event,
          platform,
          schemes,
          onDeployed,
        ),
      );
      if (logs.length > 0) deps.setOutput(logName, logs.join("\n"));
      for (const preview of result.previews) {
        previews.push(preview);
        schemeOf.set(preview, preview.scheme);
      }
      failed = result.failures;
    }
    for (const failure of failed) {
      // A failure after the deploy leaves the channel with this run's
      // bundle, which the comment can't name a commit for any more.
      failures.push({
        platform,
        ...(failure.scheme === undefined ? {} : { scheme: failure.scheme }),
        error: failure.error,
        deployed: failure.deployed ?? deployed,
      });
    }
    // The run fails with it at the end; say so now, before the next build.
    if (failed.length > 0 && platform !== inputs.platforms.at(-1)) {
      deps.log.error(
        failed
          .map(
            ({ scheme, error }) =>
              `${labelOf(platform, scheme)}: ${messageOf(error)}`,
          )
          .join("\n"),
      );
    }
  }
  // Set before any failure ends the run, so the comment job shows it.
  deps.setOutput(
    "result",
    JSON.stringify(
      laneResult({
        channel: inputs.channel,
        commitSha: event.commitSha,
        previews: previews.map((preview) => ({
          ...preview,
          scheme: schemeOf.get(preview),
        })),
        // A lane of one scheme names it, beside another lane's of the same
        // platform.
        failed: failures.map((failure) => {
          const schemes = inputs.schemes[failure.platform] ?? [];
          return failure.scheme === undefined && schemes.length === 1
            ? { ...failure, scheme: schemes[0] }
            : failure;
        }),
      }),
    ),
  );
  // With nothing deployed, the comment still says what the channel has.
  if (previews.length === 0 && failures.every(({ deployed }) => !deployed)) {
    throw failureOf(failures);
  }
  // The comment's QR codes live on a branch of the repository, which shows
  // them to anyone who can read it, whatever network the Console is on.
  /** @type {Record<string, string>} */
  let qrImages = {};
  /** @type {unknown} */
  let qrError;
  if (inputs.comment && deps.github) {
    try {
      qrImages = await writeQrCodes(
        deps.github,
        event.number,
        qrCodeValues(previews),
      );
    } catch (error) {
      // The comment still gets its links; the run fails after it.
      qrError = error;
    }
  }
  const body = renderPreviewComment({
    consoleUrl: inputs.consoleUrl,
    channel: inputs.channel,
    previews,
    qrImages,
    commitSha: event.commitSha,
    repositoryUrl: event.repositoryUrl,
    failed: failures.map(({ platform, scheme, deployed }) => ({
      platform,
      ...(scheme === undefined ? {} : { scheme }),
      deployed,
    })),
    runUrl: event.runUrl,
    credit: inputs.credit,
  });
  /** @type {(PlatformPreview & PreviewOutputs)[]} */
  const outputs = [];
  for (const preview of previews) {
    outputs.push({
      ...preview,
      // A job with `build: false` looks up nothing: its lanes have the URLs.
      downloadUrl:
        inputs.reported === null
          ? await findDownloadUrl(deps, inputs, preview, schemeOf.get(preview))
          : null,
    });
  }
  deps.setOutput("previews", JSON.stringify(outputs));
  // A platform's outputs are its first successful listed scheme's.
  /** @type {Set<Platform>} */
  const named = new Set();
  for (const { platform, installUrl, downloadUrl, store, sandbox } of outputs) {
    if (named.has(platform)) continue;
    named.add(platform);
    deps.setOutput(`${platform}-install-url`, installUrl);
    deps.setOutput(`${platform}-download-url`, downloadUrl ?? "");
    if (sandbox) deps.setOutput(`${platform}-sandbox-link`, sandbox.link ?? "");
    if (store) {
      deps.setOutput(`${platform}-store-url`, store.url ?? "");
      deps.setOutput(`${platform}-store-state`, store.state ?? "");
    }
  }
  deps.setOutput("comment-body", body);
  if (inputs.comment && deps.github) {
    await upsertComment(deps.github, event.number, body);
  }
  if (failures.length > 0) {
    if (qrError) deps.log.error(messageOf(qrError));
    throw failureOf(failures);
  }
  if (qrError) throw qrError;
  return { previews: outputs, body };
};

/**
 * @typedef {object} LaneResult What a lane's `result` output holds: the
 *   fields the comment shows, which the comment shows anyway, and nothing
 *   else. No download or storage URL, no credential, and no error or log.
 * @property {string} channel
 * @property {string} commitSha
 * @property {(PlatformPreview & { scheme?: string })[]} previews
 * @property {{ platform: Platform, scheme?: string, deployed: boolean }[]} failed
 */

/**
 * Copies of a preview's public fields, from what a run made or what a lane's
 * output says.
 *
 * @param {any} preview
 * @returns {PlatformPreview & { scheme?: string }}
 */
const publicPreview = ({
  platform,
  scheme,
  target,
  nativeBuild,
  built,
  bundleId,
  store,
  sandbox,
}) => ({
  platform,
  ...(typeof scheme === "string" ? { scheme } : {}),
  target: {
    fingerprintHash: target.fingerprintHash ?? null,
    appVersion: target.appVersion ?? null,
  },
  nativeBuild: {
    id: nativeBuild.id,
    artifactKind: nativeBuild.artifactKind,
    fileName: nativeBuild.fileName,
    ...(typeof nativeBuild.expiresAtMs === "number"
      ? { expiresAtMs: nativeBuild.expiresAtMs }
      : {}),
  },
  built: Boolean(built),
  bundleId: bundleId ?? null,
  ...(store
    ? {
        store: {
          destination: store.destination,
          url: store.url ?? null,
          version: store.version ?? null,
          state: store.state ?? null,
          expiresAtMs: null,
          reusable: true,
        },
      }
    : {}),
  ...(sandbox
    ? {
        sandbox: {
          appId: sandbox.appId,
          urlScheme: sandbox.urlScheme,
          link: sandbox.link ?? null,
          minBundleId: sandbox.minBundleId ?? null,
          fromChannel: sandbox.fromChannel ?? null,
        },
      }
    : {}),
});

/**
 * @param {{ channel: string, commitSha: string, previews: any[], failed: { platform: Platform, scheme?: string, deployed: boolean }[] }} result
 * @returns {LaneResult}
 */
export const laneResult = ({ channel, commitSha, previews, failed }) => ({
  channel,
  commitSha,
  previews: previews.map(publicPreview),
  failed: failed.map(({ platform, scheme, deployed }) => ({
    platform,
    ...(scheme === undefined ? {} : { scheme }),
    deployed,
  })),
});

/**
 * Each lane of the `results` input, one per line: its job's name, its
 * conclusion, then its `result` output, which is empty when the job set
 * none. A result that isn't one counts as none.
 *
 * @param {string} text
 * @returns {{ name: string, status: string, result: LaneResult | null }[]}
 */
export const parseLanes = (text) =>
  text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\S+)\s+(\S+)\s*(.*?)\s*$/.exec(line);
    if (!match) return [];
    const [, name = "", status = "", json = ""] = match;
    /** @type {LaneResult | null} */
    let result = null;
    try {
      const value = JSON.parse(json);
      result = laneResult({
        channel: String(value.channel),
        commitSha: String(value.commitSha),
        previews: value.previews,
        failed: value.failed,
      });
    } catch {
      result = null;
    }
    return [{ name, status, result }];
  });

/**
 * Writes the one comment, and its QR codes, from the jobs that previewed the
 * pull request at the same time. A build appears once, with the bundle a job
 * deployed to it when one did, and a failure once per platform and scheme; a
 * job with no result gets a line. With no bundle deployed anywhere, the
 * comment stays as it is. The pull request's head is read before anything
 * is written and again just before the comment is, and a newer head than
 * this run's skips the comment, which that head's run writes. GitHub has no
 * transaction across the two, so a push landing during that last write can
 * still see this run's comment until its own run replaces it.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {PullRequestEvent} event
 */
export const runComment = async (deps, inputs, event) => {
  const lanes = parseLanes(inputs.results);
  /** @type {Map<string, PlatformPreview & { scheme?: string }>} */
  const builds = new Map();
  /** @type {Map<string, import("./comment.mjs").FailedPreview>} */
  const failures = new Map();
  let { commitSha } = event;
  let { channel } = inputs;
  for (const { name, status, result } of lanes) {
    if (result === null) {
      failures.set(`lane:${name}`, {
        lane: name,
        status: status === "skipped" ? "skipped" : "missing",
      });
      continue;
    }
    ({ commitSha, channel } = result);
    // A build is built for this commit when its lane built it, whichever
    // job deployed its bundle.
    for (const preview of result.previews) {
      const seen = builds.get(preview.nativeBuild.id);
      const kept =
        seen === undefined || seen.bundleId === null ? preview : seen;
      builds.set(preview.nativeBuild.id, {
        ...kept,
        built: preview.built || Boolean(seen?.built),
      });
    }
    for (const failure of result.failed) {
      const key = `${failure.platform}:${failure.scheme ?? ""}`;
      const seen = failures.get(key);
      if (
        seen === undefined ||
        (failure.deployed && "deployed" in seen && !seen.deployed)
      ) {
        failures.set(key, failure);
      }
    }
  }
  // A build is installable only when a result of this run deployed a
  // bundle to it. One no result did is dropped, and its platform gets a line
  // when no failure of its scheme says why, as when its deploy job never ran.
  const previews = [...builds.values()].filter(
    ({ bundleId }) => bundleId !== null,
  );
  for (const { platform, scheme, bundleId } of builds.values()) {
    if (bundleId === null && !failures.has(`${platform}:${scheme ?? ""}`)) {
      failures.set(`undeployed:${platform}`, { platform, undeployed: true });
    }
  }
  const failed = [...failures.values()];
  // A build no job deployed a bundle to doesn't count.
  if (
    previews.every(({ bundleId }) => bundleId === null) &&
    failed.every((failure) => !("deployed" in failure) || !failure.deployed)
  ) {
    deps.log.notice(
      "No job deployed a bundle, so the comment stays as it was.",
    );
    return { written: false };
  }
  const github = inputs.comment ? deps.github : null;
  /** Whether the pull request has moved past this run's head. */
  const stale = async () => {
    if (!github || !event.headSha) return false;
    const head = await pullRequestHead(github, event.number);
    if (head === event.headSha) return false;
    deps.log.notice(
      `Not writing the comment: the pull request's head is ${head.slice(0, 7)} now, not this run's ${event.headSha.slice(0, 7)}.`,
    );
    return true;
  };
  if (await stale()) return { written: false };
  /** @type {Record<string, string>} */
  let qrImages = {};
  /** @type {unknown} */
  let qrError;
  if (github) {
    try {
      qrImages = await writeQrCodes(
        github,
        event.number,
        qrCodeValues(previews),
      );
    } catch (error) {
      qrError = error;
    }
  }
  const body = renderPreviewComment({
    consoleUrl: inputs.consoleUrl,
    channel,
    previews,
    qrImages,
    commitSha,
    repositoryUrl: event.repositoryUrl,
    failed,
    runUrl: event.runUrl,
    credit: inputs.credit,
  });
  deps.setOutput("comment-body", body);
  if (github) {
    const existing = await findComment(github, event.number);
    if (await stale()) return { written: false };
    if (existing) await updateComment(github, existing.id, body);
    else await createComment(github, event.number, body);
  }
  if (qrError) throw qrError;
  return { written: github !== null, body };
};

/** @param {unknown} error */
const messageOf = (error) =>
  error instanceof Error ? error.message : String(error);

/**
 * A platform as a failure names it, with the scheme when it has several.
 * @param {Platform} platform
 * @param {string | undefined} scheme
 */
const labelOf = (platform, scheme) =>
  scheme === undefined ? platform : `${platform} (${scheme})`;

/**
 * The error a run with failed platforms ends with: the one platform's own,
 * or each platform's message.
 * @param {{ platform: Platform, scheme?: string, error: unknown }[]} failures
 */
const failureOf = (failures) =>
  failures.length === 1
    ? failures[0]?.error
    : new Error(
        failures
          .map(
            ({ platform, scheme, error }) =>
              `${labelOf(platform, scheme)}: ${messageOf(error)}`,
          )
          .join("\n"),
      );

/**
 * Deletes the closed pull request's bundles and the normal native builds that
 * embed its channel, each with its artifact, and the channel, and says so in
 * its comment. Its sandbox builds stay, merged or not, since other pull
 * requests with the same native code reuse them, and so does the channel they
 * embed. It fails when the channel is kept for anything else, as when a
 * bundle or a build is added to it meanwhile.
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
    "--keep-sandbox-builds",
    "--yes",
    "--json",
  ];
  const { code, stdout } = await deps.cli(args, { capture: true });
  const result =
    /** @type {{ deleted: boolean, reason?: string, deletedBundleIds?: string[], deletedNativeBuildIds?: string[], keptNativeBuildIds?: string[] }} */ (
      parseJsonOutput(stdout)
    );
  const outcome =
    result.reason === "not_found"
      ? "missing"
      : result.reason === "sandbox_builds"
        ? "kept-sandbox"
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
    keptSandboxBuilds: result.keptNativeBuildIds?.length ?? 0,
    credit: inputs.credit,
  });
  deps.setOutput("comment-body", body);
  // A pull request that was never previewed gets no comment.
  if (inputs.comment && deps.github) {
    const existing = await findComment(deps.github, event.number);
    if (existing) await updateComment(deps.github, existing.id, body);
    // The closed comment has no QR code.
    await removeQrCodes(deps.github, event.number);
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
    : inputs.mode === "comment"
      ? runComment(deps, inputs, event)
      : runPreview(deps, inputs, event);
};
