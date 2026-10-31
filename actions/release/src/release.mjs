// @ts-check

import {
  assertBuildRunner,
  runNativeBuild,
} from "../../native-build/src/nativeBuild.mjs";
import {
  deployBundle,
  findNativeBuild,
  parseFlag,
  parsePlatforms,
  parseSchemes,
  refreshFingerprint,
} from "../../shared/nativeBuild.mjs";

/**
 * @typedef {import("../../shared/nativeBuild.mjs").Platform} Platform
 * @typedef {import("../../shared/nativeBuild.mjs").NativeBuildFindResult} NativeBuildFindResult
 * @typedef {import("../../shared/nativeBuild.mjs").NativeBuildRow} NativeBuildRow
 *
 * @typedef {object} Inputs
 * @property {Platform[]} platforms
 * @property {Partial<Record<Platform, string>>} schemes The `nativeBuild`
 *   scheme of each platform's store build.
 * @property {string | null} channel The channel to release on, or null for
 *   the one a build of the native project would embed.
 * @property {boolean} submit Whether a native build goes to the store.
 * @property {boolean} dryRun Whether to only look up and print the decision.
 *
 * @typedef {object} Deps
 * @property {import("../../shared/cli.mjs").Cli} cli
 * @property {import("../../shared/cli.mjs").BuildLogs} buildLogs
 * @property {(name: string, value: string) => void} setOutput
 * @property {{ info: (message: string) => void, notice: (message: string) => void, group: <T>(name: string, run: () => Promise<T>) => Promise<T> }} log
 * @property {(markdown: string) => void} summary Appends to the job's summary.
 *
 * @typedef {"ota" | "build"} Decision
 *
 * @typedef {object} PlatformResult One platform's line of the result.
 * @property {Platform} platform
 * @property {string} scheme
 * @property {string | null} channel
 * @property {string | null} fingerprintHash
 * @property {string | null} appVersion
 * @property {Decision | "none"} decision `none` when the lookup failed, which
 *   says nothing about the registry, so nothing runs.
 * @property {string} reason
 * @property {"deployed" | "built" | "decided" | "failed"} outcome
 * @property {string | null} nativeBuildId
 * @property {string | null} bundleId
 * @property {"testflight" | "play-internal" | null} submittedTo
 * @property {string | null} error
 */

/** The store track each platform's native builds go to. */
const STORES = /** @type {const} */ ({
  ios: { id: "testflight", name: "TestFlight" },
  android: { id: "play-internal", name: "Google Play internal testing" },
});

/**
 * The action's inputs, from the environment its composite step passes.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Inputs}
 */
export const parseInputs = (env) => {
  /** @param {string} name */
  const input = (name) => env[`INPUT_${name}`]?.trim() ?? "";

  const platforms = input("PLATFORMS");
  if (platforms === "") {
    throw new Error("platforms is required: ios, android, or both.");
  }
  const parsed = parsePlatforms(platforms);
  const schemes = parseSchemes(input);
  for (const platform of parsed) {
    if (schemes[platform] === undefined) {
      throw new Error(
        `${platform}-scheme is required: the nativeBuild.${platform} scheme of the store build.`,
      );
    }
  }
  return {
    platforms: parsed,
    schemes,
    channel: input("CHANNEL") || null,
    submit: parseFlag(input, "SUBMIT", true),
    dryRun: parseFlag(input, "DRY_RUN", false),
  };
};

/**
 * Whether a tracked build is one the store can take. HOT-72 adds sandbox
 * builds, which keep the store build's fingerprint but never replace it, so
 * this names the column it adds. `native-build find` returns only the newest
 * build of a scope, so HOT-72 must also skip sandbox builds there: otherwise
 * a sandbox build newer than the store build reads as no store build here.
 *
 * @param {NativeBuildRow & { sandbox?: boolean | null }} build
 */
export const isStoreBuild = (build) => build.sandbox !== true;

/**
 * Whether the release deploys a bundle or needs a native build. A tracked
 * build is recorded before its upload, so a tracked build with no submission
 * may be one whose upload failed: deploying over it would turn the rerun of a
 * failed submit green with nothing in the store, so it goes through
 * `native-build --submit`, which reuses the build while its inputs are the
 * same. A build registered from elsewhere (`native-build import`), which has
 * no build key, is taken to be in the store already.
 *
 * @param {NativeBuildFindResult} found
 * @param {Pick<Inputs, "submit">} inputs
 * @returns {{ decision: Decision, reason: string }}
 */
export const decide = (found, { submit }) => {
  const build = found.nativeBuild;
  if (build === null) {
    return {
      decision: "build",
      reason: `no tracked native build on ${found.channel}`,
    };
  }
  if (!isStoreBuild(build)) {
    return {
      decision: "build",
      reason: `native build ${build.id} is a sandbox build`,
    };
  }
  const store = STORES[found.platform];
  if (!submit || (build.build_key ?? null) === null) {
    return { decision: "ota", reason: `native build ${build.id} is tracked` };
  }
  return build.submitted_to === store.id
    ? {
        decision: "ota",
        reason: `native build ${build.id} is on ${store.name}`,
      }
    : {
        decision: "build",
        reason: `native build ${build.id} has no ${store.name} submission`,
      };
};

/**
 * A lookup's output that says something else than "no build" is a failed
 * lookup, never a reason to build.
 *
 * @param {NativeBuildFindResult} found
 */
const assertLookup = (found) => {
  if (
    found.nativeBuild === undefined ||
    typeof found.channel !== "string" ||
    (found.fingerprintHash === null && found.appVersion === null)
  ) {
    throw new Error("native-build find printed no build, channel, or target.");
  }
};

/**
 * The fingerprint in a decision's line and table.
 *
 * @param {Pick<PlatformResult, "fingerprintHash" | "appVersion">} target
 */
const shortTarget = ({ fingerprintHash, appVersion }) =>
  fingerprintHash !== null
    ? `fingerprint ${fingerprintHash.slice(0, 8)}`
    : appVersion !== null
      ? `app version ${appVersion}`
      : "fingerprint unknown";

/** @param {PlatformResult} result */
export const formatDecision = (result) =>
  [result.platform, shortTarget(result), result.decision, result.reason].join(
    " · ",
  );

/**
 * Sets the release's channel in the native project, and refuses to build when
 * the build would still embed another, as an Expo project's config plugin may.
 * A submitted build can't be taken back, so this runs before the build.
 *
 * @param {Deps} deps
 * @param {{ platform: Platform, scheme: string, channel: string }} options
 */
const embedChannel = async (deps, { platform, scheme, channel }) => {
  await deps.cli(["channel", "set", channel]);
  const project = await findNativeBuild(deps, { platform, scheme });
  if (project.channel !== channel) {
    throw new Error(
      `The ${platform} build would embed the ${project.channel} channel, not ${channel}. An Expo project sets it in the @hot-updater/expo config plugin.`,
    );
  }
};

/**
 * Builds, tracks, and submits one platform's native build.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {Record<string, string | undefined>} env
 * @param {PlatformResult} result
 * @param {string} channel
 */
const buildPlatform = async (deps, inputs, env, result, channel) => {
  const { platform, scheme } = result;
  const store = STORES[platform];
  assertBuildRunner(platform, env);
  if (inputs.channel !== null) {
    await embedChannel(deps, { platform, scheme, channel: inputs.channel });
  }
  const built = await runNativeBuild(
    deps,
    { platform, scheme, submit: inputs.submit ? store.id : null },
    { buildLogOutput: `${platform}-build-log` },
  );
  if (built.nativeBuild === null) {
    throw new Error(
      `The ${platform}-scheme ${scheme} builds Debug, which a store refuses: use a Release scheme.`,
    );
  }
  result.nativeBuildId = built.nativeBuild.id;
  // What the artifact embeds, such as an app version an xcconfig sets.
  result.fingerprintHash = built.build.fingerprintHash;
  result.appVersion = built.build.appVersion;
  if (built.build.channel !== channel) {
    throw new Error(
      `native-build ${platform} built a native build that embeds the ${built.build.channel} channel, not ${channel}.`,
    );
  }
  // A new build the store refused holds this commit's native code, which the
  // store's build with that number doesn't. A reused one may be that build.
  const { skipped, existing } = built.submission;
  if (
    skipped === "already-submitted" &&
    existing?.source === "store" &&
    built.cache.hit === null
  ) {
    throw new Error(
      `${store.name} already has ${existing.version ?? "this build number"}, so this build didn't reach it. Raise the build number and push again.`,
    );
  }
  result.submittedTo = inputs.submit ? store.id : null;
  result.outcome = "built";
};

/**
 * Looks up, decides, and runs one platform, whose failure stays its own, so
 * the other platform still runs and the result shows both.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @param {Record<string, string | undefined>} env
 * @param {Platform} platform
 * @returns {Promise<PlatformResult>}
 */
const releasePlatform = async (deps, inputs, env, platform) => {
  const scheme = /** @type {string} */ (inputs.schemes[platform]);
  /** @type {PlatformResult} */
  const result = {
    platform,
    scheme,
    channel: inputs.channel,
    fingerprintHash: null,
    appVersion: null,
    decision: "none",
    reason: "the lookup failed",
    outcome: "failed",
    nativeBuildId: null,
    bundleId: null,
    submittedTo: null,
    error: null,
  };
  try {
    const found = await deps.log
      .group(`Look up ${platform}`, async () => {
        const lookup = await findNativeBuild(deps, {
          platform,
          scheme,
          channel: inputs.channel,
        });
        assertLookup(lookup);
        return lookup;
      })
      .catch((error) => {
        deps.log.info(formatDecision(result));
        throw error;
      });
    result.channel = found.channel;
    result.fingerprintHash = found.fingerprintHash;
    result.appVersion = found.appVersion;
    Object.assign(result, decide(found, inputs));
    deps.log.info(formatDecision(result));

    if (inputs.dryRun) {
      result.outcome = "decided";
      return result;
    }
    if (result.decision === "build") {
      await deps.log.group(`Build ${platform}`, () =>
        buildPlatform(deps, inputs, env, result, found.channel),
      );
      return result;
    }
    result.nativeBuildId = found.nativeBuild?.id ?? null;
    await deps.log.group(`Deploy ${platform}`, async () => {
      await refreshFingerprint(deps, found);
      result.bundleId = await deployBundle(deps, {
        platform,
        channel: found.channel,
        target: found,
      });
    });
    result.outcome = "deployed";
    return result;
  } catch (error) {
    result.outcome = "failed";
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
};

/** @param {string} value */
const tableCell = (value) => value.replaceAll("|", "\\|").replaceAll("\n", " ");

/**
 * @param {PlatformResult} result
 * @returns {string}
 */
const describeOutcome = (result) => {
  switch (result.outcome) {
    case "decided":
      return "dry run";
    case "deployed":
      return `bundle \`${result.bundleId}\``;
    case "built":
      return result.submittedTo === null
        ? `native build \`${result.nativeBuildId}\``
        : `native build \`${result.nativeBuildId}\` to ${STORES[result.platform].name}`;
    case "failed":
      return `**failed**: ${result.error}`;
  }
};

/**
 * The job's summary: each platform's decision and what came of it.
 *
 * @param {PlatformResult[]} platforms
 */
export const renderSummary = (platforms) =>
  [
    "### hot-updater release",
    "",
    "| Platform | Channel | Target | Decision | Reason | Result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...platforms.map((result) => {
      const cells = [
        result.platform,
        result.channel ?? "",
        shortTarget(result),
        result.decision,
        result.reason,
        describeOutcome(result),
      ];
      return `| ${cells.map(tableCell).join(" | ")} |`;
    }),
    "",
  ].join("\n");

/**
 * Releases each platform, then sets the result and the job's summary, and
 * fails when any platform failed, naming it and the ones that finished.
 *
 * @param {Deps} deps
 * @param {Record<string, string | undefined>} env
 */
export const runAction = async (deps, env) => {
  const inputs = parseInputs(env);
  /** @type {PlatformResult[]} */
  const platforms = [];
  for (const platform of inputs.platforms) {
    platforms.push(await releasePlatform(deps, inputs, env, platform));
  }
  const failed = platforms.filter(({ outcome }) => outcome === "failed");
  const result = { dryRun: inputs.dryRun, ok: failed.length === 0, platforms };
  deps.setOutput("result", JSON.stringify(result));
  deps.summary(renderSummary(platforms));
  if (failed.length > 0) {
    const finished = platforms.filter(({ outcome }) => outcome !== "failed");
    throw new Error(
      [
        ...failed.map(({ platform, error }) => `${platform}: ${error}`),
        ...(finished.length > 0
          ? [
              `${finished.map(({ platform, outcome }) => `${platform} ${outcome}`).join(", ")}: this run released part of the push.`,
            ]
          : []),
      ].join("\n"),
    );
  }
  return result;
};
