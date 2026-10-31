// @ts-check

import { parseJsonOutput, reportBuildLogs } from "../../shared/cli.mjs";

/**
 * @typedef {"android" | "ios"} Platform
 *
 * @typedef {object} Inputs
 * @property {Platform} platform
 * @property {string} scheme
 * @property {"testflight" | "play-internal" | null} submit
 *
 * @typedef {object} Deps
 * @property {import("../../shared/cli.mjs").Cli} cli
 * @property {import("../../shared/cli.mjs").BuildLogs} buildLogs
 * @property {(name: string, value: string) => void} setOutput
 * @property {{ info: (message: string) => void, notice: (message: string) => void }} log
 * @property {(markdown: string) => void} summary Appends to the job's summary.
 *
 * @typedef {object} NativeBuildJson What `native-build <platform> --json` prints last.
 * @property {{ platform: Platform, scheme: string, artifactPath: string, artifactKind: string, minBundleId: string, channel: string, fingerprintHash: string | null, appVersion: string | null }} build
 * @property {{ id: string } | null} nativeBuild
 * @property {{ skipped: "debug" | "dry-run" | null }} registration Why the build has no record.
 * @property {{ destination: string | null, skipped: "dry-run" | "already-submitted" | null, existing: { version: string | null, source: "recorded" | "store" } | null }} submission
 *   The store the build went to, and the store's build that kept it from uploading.
 */

/** The store each platform submits to. */
const SUBMITS = /** @type {const} */ ({
  testflight: "ios",
  "play-internal": "android",
});

/**
 * Refuses an iOS build on a runner that has no Xcode.
 *
 * @param {Platform} platform
 * @param {Record<string, string | undefined>} env
 */
export const assertBuildRunner = (platform, env) => {
  if (platform === "ios" && env["RUNNER_OS"] && env["RUNNER_OS"] !== "macOS") {
    throw new Error(
      `platform ios builds with Xcode, which needs a macOS runner (runs-on: macos-latest), not ${env["RUNNER_OS"]}.`,
    );
  }
};

/**
 * The action's inputs, from the environment its composite step passes.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Inputs}
 */
export const parseInputs = (env) => {
  /** @param {string} name */
  const input = (name) => env[`INPUT_${name}`]?.trim() ?? "";

  const platform = input("PLATFORM");
  if (platform !== "android" && platform !== "ios") {
    throw new Error(
      platform === ""
        ? "platform is required: ios or android."
        : `platform takes ios or android, not ${platform}.`,
    );
  }
  assertBuildRunner(platform, env);

  const scheme = input("SCHEME");
  if (scheme === "") {
    throw new Error(
      `scheme is required: the nativeBuild.${platform} scheme in hot-updater.config.ts.`,
    );
  }

  const submit = input("SUBMIT");
  if (submit !== "" && !(submit in SUBMITS)) {
    throw new Error(
      `submit takes testflight or play-internal, or is empty, not ${submit}.`,
    );
  }
  const store = /** @type {keyof typeof SUBMITS | ""} */ (submit);
  if (store !== "" && SUBMITS[store] !== platform) {
    throw new Error(
      `submit ${store} takes ${SUBMITS[store]} builds, and platform is ${platform}.`,
    );
  }

  return {
    platform,
    scheme,
    submit: store === "" ? null : store,
  };
};

/**
 * The CLI's environment: the job's, whose variables the CLI reads its
 * credentials from, and `CI`, so the CLI never asks anything or starts a
 * sign-in, even on a runner that sets no `CI`.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export const cliEnv = (env) => ({ ...env, CI: env["CI"] || "true" });

/**
 * The `native-build <platform>` arguments of `inputs`.
 *
 * @param {Inputs} inputs
 */
export const buildArgs = (inputs) => [
  "native-build",
  inputs.platform,
  "--scheme",
  inputs.scheme,
  ...(inputs.submit ? ["--submit", inputs.submit] : []),
  "--json",
];

/**
 * Builds, tracks, and submits as the inputs ask. A build that fails sets its
 * logs as the `buildLogOutput` output.
 *
 * @param {Pick<Deps, "cli" | "buildLogs" | "setOutput" | "log">} deps
 * @param {Inputs} inputs
 * @param {{ buildLogOutput?: string }} [options]
 * @returns {Promise<NativeBuildJson>}
 */
export const runNativeBuild = async (
  deps,
  inputs,
  { buildLogOutput = "build-log" } = {},
) => {
  const args = buildArgs(inputs);
  const since = Date.now();
  const { code, stdout } = await deps.cli(args, { capture: true });
  if (code !== 0) {
    reportBuildLogs(deps, buildLogOutput, since);
    throw new Error(
      `hot-updater ${args.join(" ")} exited with ${code}: its output above says why.`,
    );
  }
  const result = /** @type {NativeBuildJson} */ (parseJsonOutput(stdout));
  // Every build is tracked but a Debug one, which has no built-in bundle.
  if (result.nativeBuild === null && result.registration?.skipped !== "debug") {
    throw new Error(`native-build ${inputs.platform} tracked no native build.`);
  }
  return result;
};

/**
 * Runs the build, and sets the outputs and the job's summary.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @returns {Promise<NativeBuildJson>}
 */
export const runAction = async (deps, inputs) => {
  const result = await runNativeBuild(deps, inputs);

  deps.setOutput("artifact-path", result.build.artifactPath);
  deps.setOutput("build", JSON.stringify(result.build));
  deps.setOutput("native-build", JSON.stringify(result.nativeBuild));

  const { build } = result;
  const rows = [
    ["Platform", build.platform],
    ["Scheme", build.scheme],
    ["Artifact", `\`${build.artifactPath}\``],
    build.fingerprintHash === null
      ? ["App version", build.appVersion ?? ""]
      : ["Fingerprint", `\`${build.fingerprintHash}\``],
    ["Channel", build.channel],
    [
      "Tracked",
      result.nativeBuild ? `\`${result.nativeBuild.id}\`` : "no (Debug build)",
    ],
    [
      "Submitted to",
      inputs.submit === "testflight"
        ? "TestFlight"
        : inputs.submit === "play-internal"
          ? "Google Play internal testing"
          : "no store",
    ],
  ];
  deps.summary(
    [
      `### hot-updater native-build ${build.platform}`,
      "",
      "| | |",
      "| --- | --- |",
      ...rows.map(([label, value]) => `| ${label} | ${value} |`),
      "",
    ].join("\n"),
  );
  return result;
};
