import { describe, expect, it, vi } from "vitest";

import { credentialMasks } from "../../shared/cli.mjs";
import { buildArgs, cliEnv, parseInputs, runAction } from "./nativeBuild.mjs";

const env = (overrides: Record<string, string> = {}) => ({
  INPUT_PLATFORM: "android",
  INPUT_SCHEME: "release",
  INPUT_UPLOAD: "play-internal",
  INPUT_REGISTER: "true",
  RUNNER_OS: "Linux",
  ...overrides,
});

const BUILD = {
  platform: "android",
  scheme: "release",
  artifactPath: "/work/android/app/build/outputs/bundle/release/app.aab",
  artifactKind: "aab",
  minBundleId: "0190a1b2-c3d4-7000-8000-02a1b2c3d4e5",
  channel: "production",
  fingerprintHash: "fp-a",
  appVersion: null,
} as const;

const deps = (
  result: { code: number; stdout: string } = {
    code: 0,
    stdout: `> Building\n${JSON.stringify({ build: BUILD, nativeBuild: { id: "nb-1" } })}\n`,
  },
) => {
  const outputs: Record<string, string> = {};
  const summaries: string[] = [];
  const cli = vi.fn(async () => result);
  return {
    deps: {
      cli,
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      log: { info: vi.fn(), notice: vi.fn() },
      summary: (markdown: string) => summaries.push(markdown),
    },
    cli,
    outputs,
    summaries,
  };
};

describe("parseInputs", () => {
  it("reads a build that registers and uploads to Google Play", () => {
    expect(parseInputs(env())).toEqual({
      platform: "android",
      scheme: "release",
      upload: "play-internal",
      register: true,
    });
  });

  it("reads an iOS build on a macOS runner, registering by default", () => {
    expect(
      parseInputs(
        env({
          INPUT_PLATFORM: "ios",
          INPUT_UPLOAD: "testflight",
          INPUT_REGISTER: "",
          RUNNER_OS: "macOS",
        }),
      ),
    ).toMatchObject({ platform: "ios", upload: "testflight", register: true });
  });

  it.each([
    [{ INPUT_PLATFORM: "" }, "platform is required: ios or android."],
    [{ INPUT_PLATFORM: "web" }, "platform takes ios or android, not web."],
    [
      { INPUT_PLATFORM: "ios", INPUT_UPLOAD: "" },
      "platform ios builds with Xcode, which needs a macOS runner (runs-on: macos-latest), not Linux.",
    ],
    [
      { INPUT_SCHEME: "" },
      "scheme is required: the nativeBuild.android scheme in hot-updater.config.ts.",
    ],
    [
      { INPUT_UPLOAD: "app-store" },
      "upload takes testflight or play-internal, or is empty, not app-store.",
    ],
    [
      { INPUT_UPLOAD: "testflight" },
      "upload testflight uploads ios builds, and platform is android.",
    ],
    [{ INPUT_REGISTER: "yes" }, "register must be true or false."],
  ])("refuses %j", (overrides, message) => {
    expect(() => parseInputs(env(overrides))).toThrow(message);
  });
});

describe("cliEnv", () => {
  it("gives the CLI the job's variables, which envSecrets() reads, and CI so it never signs in", () => {
    expect(
      cliEnv({ PATH: "/bin", HOT_UPDATER_RELEASE_KEYSTORE: "{}" }),
    ).toEqual({
      PATH: "/bin",
      CI: "true",
      HOT_UPDATER_RELEASE_KEYSTORE: "{}",
    });
  });
});

describe("credentialMasks", () => {
  it("masks credential variables and the secret fields of JSON credentials, leaving identifiers and other variables", () => {
    expect(
      credentialMasks({
        HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD: "store-pass",
        HOT_UPDATER_ASC_KEY:
          "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
        HOT_UPDATER_RELEASE_KEYSTORE: JSON.stringify({
          keystore: "a2V5c3RvcmU=",
          storePassword: "json-pass",
          keyAlias: "release",
          keyPassword: "json-key-pass",
        }),
        HOT_UPDATER_CHANNEL: "production",
        PATH: "/bin",
      }).sort(),
    ).toEqual(
      [
        "store-pass",
        "AAAA",
        JSON.stringify({
          keystore: "a2V5c3RvcmU=",
          storePassword: "json-pass",
          keyAlias: "release",
          keyPassword: "json-key-pass",
        }),
        "a2V5c3RvcmU=",
        "json-pass",
        "json-key-pass",
      ].sort(),
    );
  });
});

describe("runAction", () => {
  it("builds, registers, and uploads, then sets the outputs and the summary", async () => {
    const { deps: d, cli, outputs, summaries } = deps();

    await runAction(d, parseInputs(env()));

    expect(cli).toHaveBeenCalledWith(
      [
        "build:android",
        "--scheme",
        "release",
        "--register",
        "--upload",
        "play-internal",
        "--json",
      ],
      { capture: true },
    );
    expect(outputs).toEqual({
      "artifact-path": BUILD.artifactPath,
      build: JSON.stringify(BUILD),
      "native-build": JSON.stringify({ id: "nb-1" }),
    });
    expect(summaries[0]).toContain("| Registered | `nb-1` |");
    expect(summaries[0]).toContain(
      "| Uploaded to | Google Play internal testing |",
    );
  });

  it("only builds without upload and register", () => {
    expect(
      buildArgs(
        parseInputs(env({ INPUT_UPLOAD: "", INPUT_REGISTER: "false" })),
      ),
    ).toEqual(["build:android", "--scheme", "release", "--json"]);
  });

  it("fails with the CLI's exit code, whose output names what is missing", async () => {
    const { deps: d, outputs } = deps({
      code: 1,
      stdout: "play-service-account is not in the envSecrets secrets adapter.\n",
    });

    await expect(runAction(d, parseInputs(env()))).rejects.toThrow(
      "hot-updater build:android --scheme release --register --upload play-internal --json exited with 1: its output above says why.",
    );
    expect(outputs).toEqual({});
  });

  it("refuses a build that register left unregistered", async () => {
    const { deps: d } = deps({
      code: 0,
      stdout: JSON.stringify({ build: BUILD, nativeBuild: null }),
    });

    await expect(runAction(d, parseInputs(env()))).rejects.toThrow(
      "build:android registered no native build.",
    );
  });
});
