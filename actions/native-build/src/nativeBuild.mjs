// @ts-check

import { parseJsonOutput, reportBuildLogs } from "../../shared/cli.mjs";

/**
 * @typedef {"android" | "ios"} Platform
 *
 * @typedef {object} Inputs
 * @property {Platform} platform
 * @property {string} scheme
 * @property {"testflight" | "play-internal" | null} upload
 * @property {boolean} register
 *
 * @typedef {object} Deps
 * @property {import("../../shared/cli.mjs").Cli} cli
 * @property {import("../../shared/cli.mjs").BuildLogs} buildLogs
 * @property {(name: string, value: string) => void} setOutput
 * @property {{ info: (message: string) => void, notice: (message: string) => void }} log
 * @property {(markdown: string) => void} summary Appends to the job's summary.
 *
 * @typedef {object} NativeBuildJson What `build:* --json` prints last.
 * @property {{ platform: Platform, scheme: string, artifactPath: string, artifactKind: string, minBundleId: string, channel: string, fingerprintHash: string | null, appVersion: string | null }} build
 * @property {{ id: string } | null} nativeBuild
 */

/** The store each platform uploads to. */
const UPLOADS = /** @type {const} */ ({
  testflight: "ios",
  "play-internal": "android",
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

  const platform = input("PLATFORM");
  if (platform !== "android" && platform !== "ios") {
    throw new Error(
      platform === ""
        ? "platform is required: ios or android."
        : `platform takes ios or android, not ${platform}.`,
    );
  }
  if (platform === "ios" && env["RUNNER_OS"] && env["RUNNER_OS"] !== "macOS") {
    throw new Error(
      `platform ios builds with Xcode, which needs a macOS runner (runs-on: macos-latest), not ${env["RUNNER_OS"]}.`,
    );
  }

  const scheme = input("SCHEME");
  if (scheme === "") {
    throw new Error(
      `scheme is required: the nativeBuild.${platform} scheme in hot-updater.config.ts.`,
    );
  }

  const upload = input("UPLOAD");
  if (upload !== "" && !(upload in UPLOADS)) {
    throw new Error(
      `upload takes testflight or play-internal, or is empty, not ${upload}.`,
    );
  }
  const store = /** @type {keyof typeof UPLOADS | ""} */ (upload);
  if (store !== "" && UPLOADS[store] !== platform) {
    throw new Error(
      `upload ${store} uploads ${UPLOADS[store]} builds, and platform is ${platform}.`,
    );
  }

  const register = input("REGISTER") || "true";
  if (register !== "true" && register !== "false") {
    throw new Error("register must be true or false.");
  }

  return {
    platform,
    scheme,
    upload: store === "" ? null : store,
    register: register === "true",
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
 * The `build:*` arguments of `inputs`.
 *
 * @param {Inputs} inputs
 */
export const buildArgs = (inputs) => [
  `build:${inputs.platform}`,
  "--scheme",
  inputs.scheme,
  ...(inputs.register ? ["--register"] : []),
  ...(inputs.upload ? ["--upload", inputs.upload] : []),
  "--json",
];

/**
 * Builds, registers, and uploads as the inputs ask, and sets the outputs.
 *
 * @param {Deps} deps
 * @param {Inputs} inputs
 * @returns {Promise<NativeBuildJson>}
 */
export const runAction = async (deps, inputs) => {
  const args = buildArgs(inputs);
  const since = Date.now();
  const { code, stdout } = await deps.cli(args, { capture: true });
  if (code !== 0) {
    reportBuildLogs(deps, "build-log", since);
    throw new Error(
      `hot-updater ${args.join(" ")} exited with ${code}: its output above says why.`,
    );
  }
  const result = /** @type {NativeBuildJson} */ (parseJsonOutput(stdout));
  if (inputs.register && result.nativeBuild === null) {
    throw new Error(`build:${inputs.platform} registered no native build.`);
  }

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
    ["Registered", result.nativeBuild ? `\`${result.nativeBuild.id}\`` : "no"],
    [
      "Uploaded to",
      inputs.upload === "testflight"
        ? "TestFlight"
        : inputs.upload === "play-internal"
          ? "Google Play internal testing"
          : "no store",
    ],
  ];
  deps.summary(
    [
      `### hot-updater build:${build.platform}`,
      "",
      "| | |",
      "| --- | --- |",
      ...rows.map(([label, value]) => `| ${label} | ${value} |`),
      "",
    ].join("\n"),
  );
  return result;
};
