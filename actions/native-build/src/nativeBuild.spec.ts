import { describe, expect, it, vi } from "vitest";

import { credentialMasks } from "../../shared/cli.mjs";
import { buildArgs, cliEnv, parseInputs, runAction } from "./nativeBuild.mjs";

const env = (overrides: Record<string, string> = {}) => ({
  INPUT_PLATFORM: "android",
  INPUT_SCHEME: "release",
  INPUT_SUBMIT: "play-internal",
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
    stdout: `> Building\n${JSON.stringify({ build: BUILD, nativeBuild: { id: "nb-1" }, registration: { skipped: null } })}\n`,
  },
  /** The logs the build wrote. */
  logs: string[] = [],
) => {
  const outputs: Record<string, string> = {};
  const summaries: string[] = [];
  const cli = vi.fn(async () => result);
  const buildLogs = vi.fn((_since: number) => logs);
  return {
    deps: {
      cli,
      buildLogs,
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      log: { info: vi.fn(), notice: vi.fn() },
      summary: (markdown: string) => summaries.push(markdown),
    },
    cli,
    buildLogs,
    outputs,
    summaries,
  };
};

describe("parseInputs", () => {
  it("reads a build that submits to Google Play", () => {
    expect(parseInputs(env())).toEqual({
      platform: "android",
      scheme: "release",
      submit: "play-internal",
    });
  });

  it("reads an iOS build on a macOS runner", () => {
    expect(
      parseInputs(
        env({
          INPUT_PLATFORM: "ios",
          INPUT_SUBMIT: "testflight",
          RUNNER_OS: "macOS",
        }),
      ),
    ).toEqual({ platform: "ios", scheme: "release", submit: "testflight" });
  });

  it.each([
    [{ INPUT_PLATFORM: "" }, "platform is required: ios or android."],
    [{ INPUT_PLATFORM: "web" }, "platform takes ios or android, not web."],
    [
      { INPUT_PLATFORM: "ios", INPUT_SUBMIT: "" },
      "platform ios builds with Xcode, which needs a macOS runner (runs-on: macos-latest), not Linux.",
    ],
    [
      { INPUT_SCHEME: "" },
      "scheme is required: the nativeBuild.android scheme in hot-updater.config.ts.",
    ],
    [
      { INPUT_SUBMIT: "app-store" },
      "submit takes testflight or play-internal, or is empty, not app-store.",
    ],
    [
      { INPUT_SUBMIT: "testflight" },
      "submit testflight takes ios builds, and platform is android.",
    ],
  ])("refuses %j", (overrides, message) => {
    expect(() => parseInputs(env(overrides))).toThrow(message);
  });
});

describe("cliEnv", () => {
  it("gives the CLI the job's variables, which it reads its credentials from, and CI so it never signs in", () => {
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
  it("builds, tracks, and submits, then sets the outputs and the summary", async () => {
    const { deps: d, cli, outputs, summaries } = deps();

    await runAction(d, parseInputs(env()));

    expect(cli).toHaveBeenCalledWith(
      [
        "native-build",
        "android",
        "--scheme",
        "release",
        "--submit",
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
    expect(summaries[0]).toContain("### hot-updater native-build android");
    expect(summaries[0]).toContain("| Tracked | `nb-1` |");
    expect(summaries[0]).toContain(
      "| Submitted to | Google Play internal testing |",
    );
  });

  it("only builds, and tracks, without submit", () => {
    expect(buildArgs(parseInputs(env({ INPUT_SUBMIT: "" })))).toEqual([
      "native-build",
      "android",
      "--scheme",
      "release",
      "--json",
    ]);
  });

  it("fails with the CLI's exit code, whose output names what is missing", async () => {
    const { deps: d, outputs } = deps({
      code: 1,
      stdout: "play-service-account is not in the local secrets adapter.\n",
    });

    await expect(runAction(d, parseInputs(env()))).rejects.toThrow(
      "hot-updater native-build android --scheme release --submit play-internal --json exited with 1: its output above says why.",
    );
    expect(outputs).toEqual({});
  });

  it("prints the failed build's log and sets it as the build-log output", async () => {
    const logFile = "/work/.hot-updater/log/10261157-android-release-build.log";
    const before = Date.now();
    const {
      deps: d,
      outputs,
      buildLogs,
    } = deps({ code: 1, stdout: "> Task :app:compileReleaseKotlin FAILED\n" }, [
      logFile,
    ]);

    await expect(runAction(d, parseInputs(env()))).rejects.toThrow(
      "exited with 1",
    );

    expect(outputs).toEqual({ "build-log": logFile });
    expect(d.log.info).toHaveBeenCalledWith(`Build log: ${logFile}`);
    // The logs written since the build started, not an earlier step's.
    const [since] = buildLogs.mock.calls[0]!;
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(Date.now());
  });

  it("uploads nothing for a build that succeeded", async () => {
    const { deps: d, outputs, buildLogs } = deps(undefined, ["/work/log"]);

    await runAction(d, parseInputs(env()));

    expect(buildLogs).not.toHaveBeenCalled();
    expect(outputs).not.toHaveProperty("build-log");
  });

  it("refuses a build the CLI left untracked without saying why", async () => {
    const { deps: d } = deps({
      code: 0,
      stdout: JSON.stringify({
        build: BUILD,
        nativeBuild: null,
        registration: { skipped: null },
      }),
    });

    await expect(runAction(d, parseInputs(env()))).rejects.toThrow(
      "native-build android tracked no native build.",
    );
  });

  it("accepts a Debug build, which has no record, and says so", async () => {
    const {
      deps: d,
      outputs,
      summaries,
    } = deps({
      code: 0,
      stdout: JSON.stringify({
        build: BUILD,
        nativeBuild: null,
        registration: { skipped: "debug" },
      }),
    });

    await runAction(d, parseInputs(env({ INPUT_SUBMIT: "" })));

    expect(outputs["native-build"]).toBe("null");
    expect(summaries[0]).toContain("| Tracked | no (Debug build) |");
  });
});
