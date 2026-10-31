import { describe, expect, it, vi } from "vitest";

import { decide, formatDecision, parseInputs, runAction } from "./release.mjs";

const env = (overrides: Record<string, string> = {}) => ({
  INPUT_PLATFORMS: "android",
  INPUT_ANDROID_SCHEME: "release",
  INPUT_IOS_SCHEME: "appstore",
  RUNNER_OS: "Linux",
  ...overrides,
});

type Row = {
  id: string;
  build_key: string | null;
  submitted_to: string | null;
  sandbox?: boolean;
};

const row = (overrides: Partial<Row> = {}): Row => ({
  id: "nb-1",
  build_key: "nbk1:abc",
  submitted_to: "play-internal",
  ...overrides,
});

/**
 * The project's CLI as the commands the action runs answer: `find` looks in
 * `registry`, by platform, and each other command does what its name says.
 */
const fakeCli = ({
  registry = {} as Record<string, Row | null>,
  channel = "production",
  buildChannel,
  findFails = [] as string[],
  findStdout,
  deployFails = false,
  buildFails = false,
  built = {} as Record<string, unknown>,
}: {
  registry?: Record<string, Row | null>;
  /** The channel the native project embeds. */
  channel?: string;
  /** The channel a build's artifact embeds, when it isn't the project's. */
  buildChannel?: string;
  /** The platforms whose lookup exits non-zero. */
  findFails?: string[];
  /** What `find` prints instead of its result. */
  findStdout?: string;
  deployFails?: boolean;
  buildFails?: boolean;
  /** Fields of what `native-build <platform> --json` prints. */
  built?: Record<string, unknown>;
} = {}) => {
  const calls: string[] = [];
  let projectChannel = channel;
  const cli = vi.fn(async (args: string[]) => {
    calls.push(args.join(" "));
    const [command, sub] = args;
    const flag = (name: string) =>
      args.includes(name) ? args[args.indexOf(name) + 1]! : undefined;
    if (command === "channel" && sub === "set") {
      projectChannel = buildChannel ?? args[2]!;
      return { code: 0, stdout: "" };
    }
    if (command === "native-build" && sub === "find") {
      const platform = flag("-p")!;
      if (findFails.includes(platform)) return { code: 1, stdout: "" };
      return {
        code: 0,
        stdout:
          findStdout ??
          JSON.stringify({
            platform,
            channel: flag("-c") ?? projectChannel,
            fingerprintHash: "fp-abcdef012345",
            appVersion: null,
            nativeBuild: registry[platform] ?? null,
          }),
      };
    }
    if (command === "native-build") {
      if (buildFails) return { code: 1, stdout: "" };
      return {
        code: 0,
        stdout: JSON.stringify({
          build: {
            platform: sub,
            channel: buildChannel ?? projectChannel,
            fingerprintHash: "fp-abcdef012345",
            appVersion: null,
          },
          nativeBuild: { id: "nb-new" },
          registration: { skipped: null },
          submission: {
            destination: flag("--submit") ?? null,
            skipped: null,
            existing: null,
          },
          ...built,
        }),
      };
    }
    if (command === "deploy" && deployFails) {
      throw new Error("hot-updater deploy exited with 1.");
    }
    if (command === "bundle") {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            id: `bundle-${flag("-p")}`,
            fingerprint_hash: "fp-abcdef012345",
            target_app_version: null,
          },
        ]),
      };
    }
    return { code: 0, stdout: "" };
  });
  return { cli, calls };
};

const run = async (
  fake: ReturnType<typeof fakeCli>,
  overrides: Record<string, string> = {},
) => {
  const outputs: Record<string, string> = {};
  const summaries: string[] = [];
  const lines: string[] = [];
  const buildLogs = vi.fn((_since: number) => ["/app/build.log"]);
  const promise = runAction(
    {
      cli: fake.cli,
      buildLogs,
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      log: {
        info: (message: string) => lines.push(message),
        notice: vi.fn(),
        group: (_name: string, body: () => Promise<unknown>) => body(),
      } as never,
      summary: (markdown: string) => summaries.push(markdown),
    },
    env(overrides),
  );
  const error = await promise.then(
    () => undefined,
    (cause: Error) => cause,
  );
  return {
    error,
    outputs,
    summaries,
    lines,
    result: outputs["result"] ? JSON.parse(outputs["result"]) : undefined,
  };
};

const ran = (calls: string[], prefix: string) =>
  calls.filter((call) => call.startsWith(prefix));

describe("parseInputs", () => {
  it("reads the platforms, the schemes, and the defaults", () => {
    expect(parseInputs(env({ INPUT_PLATFORMS: "ios, android" }))).toEqual({
      platforms: ["ios", "android"],
      schemes: { android: "release", ios: "appstore" },
      channel: null,
      submit: true,
      dryRun: false,
    });
  });

  it("refuses what it can't run, before anything does", () => {
    expect(() => parseInputs(env({ INPUT_PLATFORMS: "" }))).toThrow(
      "platforms is required",
    );
    expect(() => parseInputs(env({ INPUT_PLATFORMS: "web" }))).toThrow(
      "platforms takes android and ios, not web.",
    );
    expect(() => parseInputs(env({ INPUT_ANDROID_SCHEME: "" }))).toThrow(
      "android-scheme is required",
    );
    expect(() => parseInputs(env({ INPUT_DRY_RUN: "yes" }))).toThrow(
      "dry-run must be true or false.",
    );
  });
});

describe("decide", () => {
  const found = (nativeBuild: Row | null, platform = "android") =>
    ({
      platform,
      channel: "production",
      fingerprintHash: "fp",
      appVersion: null,
      nativeBuild,
    }) as never;

  it.each([
    ["no build", null, true, "build"],
    ["a submitted build", row(), true, "ota"],
    ["a build with no submission", row({ submitted_to: null }), true, "build"],
    [
      "an imported build",
      row({ build_key: null, submitted_to: null }),
      true,
      "ota",
    ],
    ["a sandbox build", row({ sandbox: true }), true, "build"],
    ["a sandbox build without a store", row({ sandbox: true }), false, "build"],
    ["a build without a store", row({ submitted_to: null }), false, "ota"],
    ["no build without a store", null, false, "build"],
  ])("%s", (_name, nativeBuild, submit, decision) => {
    expect(decide(found(nativeBuild), { submit }).decision).toBe(decision);
  });

  it("wants the build on its own platform's store", () => {
    expect(
      decide(found(row({ submitted_to: "testflight" }), "ios"), {
        submit: true,
      }).decision,
    ).toBe("ota");
    expect(
      decide(found(row({ submitted_to: "play-internal" }), "ios"), {
        submit: true,
      }).decision,
    ).toBe("build");
  });

  it("prints one short line", () => {
    expect(
      formatDecision({
        platform: "android",
        fingerprintHash: "abcdef0123456789",
        appVersion: null,
        decision: "ota",
        reason: "native build nb-1 is on Google Play internal testing",
      } as never),
    ).toBe(
      "android · fingerprint abcdef01 · ota · native build nb-1 is on Google Play internal testing",
    );
  });
});

describe("runAction", () => {
  it("deploys only the bundle when the store has the fingerprint's build", async () => {
    const fake = fakeCli({ registry: { android: row() } });
    const { error, result, summaries } = await run(fake);

    expect(error).toBeUndefined();
    expect(fake.calls).toEqual([
      "native-build find -p android -s release --json",
      "fingerprint create",
      "deploy -p android -c production",
      "bundle list -c production -p android --limit 1 --json",
    ]);
    expect(result.ok).toBe(true);
    expect(result.platforms[0]).toMatchObject({
      decision: "ota",
      outcome: "deployed",
      nativeBuildId: "nb-1",
      bundleId: "bundle-android",
      submittedTo: null,
    });
    expect(summaries[0]).toContain(
      "| android | production | fingerprint fp-abcde | ota |",
    );
  });

  it("builds and submits, and deploys nothing, when no build has the fingerprint", async () => {
    const fake = fakeCli();
    const { error, result } = await run(fake);

    expect(error).toBeUndefined();
    expect(fake.calls).toEqual([
      "native-build find -p android -s release --json",
      "native-build android --scheme release --submit play-internal --json",
    ]);
    expect(result.platforms[0]).toMatchObject({
      decision: "build",
      outcome: "built",
      nativeBuildId: "nb-new",
      bundleId: null,
      submittedTo: "play-internal",
    });
  });

  it("submits a tracked build whose upload never finished, instead of going green on a bundle", async () => {
    const fake = fakeCli({
      registry: { android: row({ submitted_to: null }) },
    });
    const { result } = await run(fake);

    expect(ran(fake.calls, "deploy")).toEqual([]);
    expect(ran(fake.calls, "native-build android")).toHaveLength(1);
    expect(result.platforms[0].reason).toBe(
      "native build nb-1 has no Google Play internal testing submission",
    );
  });

  it("only builds without a store", async () => {
    const fake = fakeCli();
    const { result } = await run(fake, { INPUT_SUBMIT: "false" });

    expect(ran(fake.calls, "native-build android")).toEqual([
      "native-build android --scheme release --json",
    ]);
    expect(result.platforms[0].submittedTo).toBeNull();
  });

  it("only looks up on a dry run, and writes nothing", async () => {
    const fake = fakeCli({
      registry: { ios: row({ submitted_to: "testflight" }) },
    });
    const { error, result, lines } = await run(fake, {
      INPUT_PLATFORMS: "android,ios",
      INPUT_CHANNEL: "beta",
      INPUT_DRY_RUN: "true",
    });

    expect(error).toBeUndefined();
    expect(fake.calls).toEqual([
      "native-build find -p android -c beta -s release --json",
      "native-build find -p ios -c beta -s appstore --json",
    ]);
    expect(result).toMatchObject({
      dryRun: true,
      ok: true,
      platforms: [
        { platform: "android", decision: "build", outcome: "decided" },
        { platform: "ios", decision: "ota", outcome: "decided" },
      ],
    });
    expect(lines).toEqual([
      "android · fingerprint fp-abcde · build · no tracked native build on beta",
      "ios · fingerprint fp-abcde · ota · native build nb-1 is on TestFlight",
    ]);
  });

  it("deploys and builds nothing when the lookup fails: a failed lookup isn't no build", async () => {
    const fake = fakeCli({ findFails: ["android"] });
    const { error, result, lines } = await run(fake);

    expect(error?.message).toContain("android: hot-updater native-build find");
    expect(fake.calls).toEqual([
      "native-build find -p android -s release --json",
    ]);
    expect(result).toMatchObject({
      ok: false,
      platforms: [{ decision: "none", outcome: "failed" }],
    });
    expect(lines).toEqual([
      "android · fingerprint unknown · none · the lookup failed",
    ]);
  });

  it.each([
    ["no JSON", "Loading config\n"],
    [
      "JSON without a nativeBuild",
      '{"platform":"android","channel":"production","fingerprintHash":"fp","appVersion":null}',
    ],
    [
      "JSON without a target",
      '{"platform":"android","channel":"production","fingerprintHash":null,"appVersion":null,"nativeBuild":null}',
    ],
  ])("treats a lookup that prints %s as failed", async (_name, findStdout) => {
    const fake = fakeCli({ findStdout });
    const { error, result } = await run(fake);

    expect(error).toBeDefined();
    expect(fake.calls).toHaveLength(1);
    expect(result.platforms[0].decision).toBe("none");
  });

  it("runs the other platform when one fails, shows both, and fails the run", async () => {
    const fake = fakeCli({
      findFails: ["ios"],
      registry: { android: row() },
    });
    const { error, result, summaries } = await run(fake, {
      INPUT_PLATFORMS: "ios,android",
    });

    expect(ran(fake.calls, "deploy")).toEqual([
      "deploy -p android -c production",
    ]);
    expect(result).toMatchObject({
      ok: false,
      platforms: [
        { platform: "ios", decision: "none", outcome: "failed" },
        { platform: "android", decision: "ota", outcome: "deployed" },
      ],
    });
    expect(error?.message).toContain("ios: hot-updater native-build find");
    expect(error?.message).toContain(
      "android deployed: this run released part of the push.",
    );
    expect(summaries[0]).toContain("**failed**");
    expect(summaries[0]).toContain("bundle `bundle-android`");
  });

  it("fails a deploy that fails, with its decision", async () => {
    const fake = fakeCli({ registry: { android: row() }, deployFails: true });
    const { error, result } = await run(fake);

    expect(error?.message).toContain(
      "android: hot-updater deploy exited with 1.",
    );
    expect(result.platforms[0]).toMatchObject({
      decision: "ota",
      outcome: "failed",
    });
  });

  it("sets the build log's output when a build fails", async () => {
    const fake = fakeCli({ buildFails: true });
    const { error, outputs, result } = await run(fake);

    expect(error?.message).toContain(
      "android: hot-updater native-build android",
    );
    expect(outputs["android-build-log"]).toBe("/app/build.log");
    expect(result.platforms[0]).toMatchObject({
      decision: "build",
      outcome: "failed",
    });
  });

  it("refuses an iOS build on a Linux runner, but deploys its bundle there", async () => {
    const build = fakeCli();
    const refused = await run(build, {
      INPUT_PLATFORMS: "ios",
    });
    expect(refused.error?.message).toContain("needs a macOS runner");
    expect(ran(build.calls, "native-build ios")).toEqual([]);

    const deploy = fakeCli({
      registry: { ios: row({ submitted_to: "testflight" }) },
    });
    const deployed = await run(deploy, { INPUT_PLATFORMS: "ios" });
    expect(deployed.error).toBeUndefined();
    expect(ran(deploy.calls, "deploy")).toEqual([
      "deploy -p ios -c production",
    ]);
  });

  it("sets the channel before a build, and refuses before it builds one that embeds another", async () => {
    const set = fakeCli();
    await run(set, { INPUT_CHANNEL: "beta" });
    expect(set.calls).toEqual([
      "native-build find -p android -c beta -s release --json",
      "channel set beta",
      "native-build find -p android -s release --json",
      "native-build android --scheme release --submit play-internal --json",
    ]);

    const expo = fakeCli({ buildChannel: "production" });
    const { error } = await run(expo, { INPUT_CHANNEL: "beta" });
    expect(error?.message).toContain(
      "The android build would embed the production channel, not beta.",
    );
    expect(ran(expo.calls, "native-build android")).toEqual([]);
  });

  it("sets no channel on a deploy", async () => {
    const fake = fakeCli({ registry: { android: row() } });
    await run(fake, { INPUT_CHANNEL: "beta" });
    expect(ran(fake.calls, "channel")).toEqual([]);
    expect(ran(fake.calls, "deploy")).toEqual(["deploy -p android -c beta"]);
  });

  it.each([
    ["a new build", { hit: null }],
    // A build the store refused is tracked and reused by the rerun, which
    // finds the store's build by its number alone.
    ["a reused build", { hit: "storage" }],
  ])(
    "fails %s the store matched by number alone, which may hold other native code",
    async (_name, cache) => {
      const fake = fakeCli({
        built: {
          cache,
          submission: {
            destination: "play-internal",
            skipped: "already-submitted",
            existing: { version: "1.0 (7)", source: "store" },
          },
        },
      });
      const { error, result } = await run(fake);

      expect(error?.message).toContain(
        "Google Play internal testing already has 1.0 (7), which may be another build. Raise the build number and push again.",
      );
      expect(result.platforms[0]).toMatchObject({
        outcome: "failed",
        submittedTo: null,
        nativeBuildId: "nb-new",
      });
    },
  );

  it("accepts a build whose submission Hot Updater recorded", async () => {
    const fake = fakeCli({
      built: {
        submission: {
          destination: "play-internal",
          skipped: "already-submitted",
          existing: { version: "1.0 (7)", source: "recorded" },
        },
      },
    });
    const { error, result } = await run(fake);

    expect(error).toBeUndefined();
    expect(result.platforms[0].outcome).toBe("built");
  });

  it("refuses a Debug scheme", async () => {
    const fake = fakeCli({
      built: { nativeBuild: null, registration: { skipped: "debug" } },
    });
    const { error } = await run(fake);
    expect(error?.message).toContain("builds Debug");
  });

  it("fails a build that embeds another channel than it looked up", async () => {
    const fake = fakeCli({ buildChannel: "staging" });
    const { error, result } = await run(fake);
    expect(error?.message).toContain(
      "embeds the staging channel, not production.",
    );
    expect(result.platforms[0].outcome).toBe("failed");
  });

  it("sets nothing when the inputs are wrong", async () => {
    const fake = fakeCli();
    const { error, outputs } = await run(fake, { INPUT_PLATFORMS: "web" });
    expect(error?.message).toContain("not web");
    expect(fake.calls).toEqual([]);
    expect(outputs).toEqual({});
  });
});
