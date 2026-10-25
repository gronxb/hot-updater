import { describe, expect, it, vi } from "vitest";

import { buildArgs, cliEnv, parseInputs, runAction } from "./nativeBuild.mjs";

const env = (overrides: Record<string, string> = {}) => ({
  INPUT_CONSOLE_URL: "https://console.example.com",
  INPUT_VAULT_TOKEN: "hu_vault_token",
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
      vault: { url: "https://console.example.com", token: "hu_vault_token" },
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

  it("reads no vault when neither connection input is set", () => {
    expect(
      parseInputs(env({ INPUT_CONSOLE_URL: "", INPUT_VAULT_TOKEN: "" })).vault,
    ).toBeNull();
  });

  it.each([
    [
      { INPUT_VAULT_TOKEN: "" },
      "console-url is set but vault-token is empty: set both to read credentials from the vault, or neither to read them from the job's HOT_UPDATER_* environment variables. A workflow run from a fork gets no secrets.",
    ],
    [
      { INPUT_CONSOLE_URL: "" },
      "vault-token is set but console-url is empty",
    ],
    [
      { INPUT_CONSOLE_URL: "console.example.com" },
      "console-url must be the Console's http(s) URL.",
    ],
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
  it("gives the CLI the vault connection, and CI so it never signs in", () => {
    expect(
      cliEnv({ PATH: "/bin" }, parseInputs(env())),
    ).toEqual({
      PATH: "/bin",
      CI: "true",
      HOT_UPDATER_CONSOLE_URL: "https://console.example.com",
      HOT_UPDATER_VAULT_TOKEN: "hu_vault_token",
    });
  });

  it("keeps the job's HOT_UPDATER_* variables without a vault", () => {
    expect(
      cliEnv(
        { CI: "true", HOT_UPDATER_ASC_KEY: "key" },
        parseInputs(env({ INPUT_CONSOLE_URL: "", INPUT_VAULT_TOKEN: "" })),
      ),
    ).toEqual({ CI: "true", HOT_UPDATER_ASC_KEY: "key" });
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
    expect(summaries[0]).toContain("| Uploaded to | Google Play internal testing |");
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
      stdout:
        "play-service-account is not in the vault at https://console.example.com.\n",
    });

    await expect(runAction(d, parseInputs(env()))).rejects.toThrow(
      "hot-updater build:android --scheme release --register --upload play-internal --json exited with 1: its output above says why.",
    );
    expect(outputs).toEqual({});
  });

  it("says when every credential comes from the environment", async () => {
    const { deps: d } = deps();

    await runAction(
      d,
      parseInputs(env({ INPUT_CONSOLE_URL: "", INPUT_VAULT_TOKEN: "" })),
    );

    expect(d.log.notice).toHaveBeenCalledWith(
      "No console-url and vault-token: the CLI reads every credential from the job's HOT_UPDATER_* environment variables.",
    );
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
