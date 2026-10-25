// @ts-check

import { parseJsonOutput } from "../../shared/cli.mjs";

/**
 * @typedef {"android" | "ios"} Platform
 *
 * @typedef {object} Inputs
 * @property {{ url: string, token: string } | null} vault The Console's
 *   vault, or null when the job's environment sets every credential.
 * @property {Platform} platform
 * @property {string} scheme
 * @property {"testflight" | "play-internal" | null} upload
 * @property {boolean} register
 *
 * @typedef {object} Deps
 * @property {import("../../shared/cli.mjs").Cli} cli
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

  const url = input("CONSOLE_URL");
  const token = input("VAULT_TOKEN");
  if ((url === "") !== (token === "")) {
    throw new Error(
      url === ""
        ? "vault-token is set but console-url is empty: set both to read credentials from the vault, or neither to read them from the job's HOT_UPDATER_* environment variables."
        : "console-url is set but vault-token is empty: set both to read credentials from the vault, or neither to read them from the job's HOT_UPDATER_* environment variables. A workflow run from a fork gets no secrets.",
    );
  }
  if (url !== "" && !/^https?:\/\//.test(url)) {
    throw new Error("console-url must be the Console's http(s) URL.");
  }

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
    vault: url === "" ? null : { url, token },
    platform,
    scheme,
    upload: store === "" ? null : store,
    register: register === "true",
  };
};

/**
 * The CLI's environment: the vault connection, and `CI`, so the CLI never
 * asks anything or starts a sign-in, even on a runner that sets no `CI`.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Inputs} inputs
 * @returns {Record<string, string | undefined>}
 */
export const cliEnv = (env, inputs) => ({
  ...env,
  CI: env["CI"] || "true",
  ...(inputs.vault
    ? {
        HOT_UPDATER_CONSOLE_URL: inputs.vault.url,
        HOT_UPDATER_VAULT_TOKEN: inputs.vault.token,
      }
    : {}),
});

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
  if (!inputs.vault) {
    deps.log.notice(
      "No console-url and vault-token: the CLI reads every credential from the job's HOT_UPDATER_* environment variables.",
    );
  }
  const args = buildArgs(inputs);
  const { code, stdout } = await deps.cli(args, { capture: true });
  if (code !== 0) {
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
