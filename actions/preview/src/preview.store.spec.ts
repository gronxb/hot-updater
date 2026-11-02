import { describe, expect, it, vi } from "vitest";

import { parseInputs, runAction } from "./preview.mjs";

const event = {
  action: "synchronize",
  number: 12,
  title: "Fix the header",
  headSha: "0123456789abcdef",
  fromFork: false,
};

const env = (overrides: Record<string, string> = {}) => ({
  INPUT_CONSOLE_URL: "https://console.example.com",
  INPUT_PLATFORMS: "ios",
  INPUT_IOS_SCHEME: "sandbox",
  INPUT_IOS_SUBMIT: "testflight",
  INPUT_COMMENT: "false",
  ...overrides,
});

const TESTFLIGHT_URL =
  "https://appstoreconnect.apple.com/apps/6764/testflight/ios";

const row = (submitted: boolean) => ({
  id: "build-1",
  artifact_kind: "ipa",
  artifact_storage_uri: "s3://bucket/native-builds/ios/build-1/App.ipa",
  build_key: "key-1",
  submitted_to: submitted ? "testflight" : null,
  submitted_version: submitted ? "1.7.0 (66)" : null,
});

const store = (state: string, reusable = true) => ({
  destination: "testflight",
  url: TESTFLIGHT_URL,
  version: "1.7.0 (66)",
  state,
  expiresAtMs: null,
  reusable,
});

/**
 * The project's CLI over what the action must learn only from it: what `find`
 * says, and what `native-build` prints, recording each command it ran.
 */
const fakeCli = ({
  channel = "sandbox-sandbox",
  found = null as ReturnType<typeof row> | null,
  foundStore = null as ReturnType<typeof store> | null,
  submission = {
    destination: "testflight",
    skipped: null,
    existing: null,
    store: store("processing"),
  } as Record<string, unknown>,
  builtChannel = "sandbox-sandbox",
  groupStore = { ...store("ready"), group: "added" } as Record<string, unknown>,
  groupFails = false,
} = {}) => {
  const calls: string[][] = [];
  const cli = vi.fn(async (args: string[]) => {
    calls.push(args);
    const [command, sub] = args;
    if (command === "native-build" && sub === "find") {
      return {
        code: 0,
        stdout: JSON.stringify({
          platform: "ios",
          channel,
          fingerprintHash: "fp-a",
          appVersion: null,
          nativeBuild: found,
          downloadUrl: found && "https://storage.example.com/App.ipa",
          ...(args.includes("--store-status") ? { store: foundStore } : {}),
        }),
      };
    }
    if (command === "native-build" && sub === "testflight-group") {
      return groupFails
        ? { code: 1, stdout: "" }
        : { code: 0, stdout: JSON.stringify(groupStore) };
    }
    if (command === "native-build") {
      return {
        code: 0,
        stdout: JSON.stringify({
          build: {
            channel: builtChannel,
            fingerprintHash: "fp-a",
            appVersion: null,
          },
          nativeBuild: { ...row(true), id: "build-2" },
          registration: { skipped: null },
          submission,
        }),
      };
    }
    if (command === "bundle") {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            id: "bundle-1",
            fingerprint_hash: "fp-a",
            target_app_version: null,
          },
        ]),
      };
    }
    return { code: 0, stdout: "" };
  });
  const words = () => calls.map((args) => args.join(" "));
  return { cli, calls, words };
};

const deps = (cli: unknown) => {
  const outputs = new Map<string, string>();
  return {
    outputs,
    deps: {
      cli,
      buildLogs: { find: () => [], since: () => [] },
      fetch: vi.fn(),
      github: null,
      setOutput: (name: string, value: string) => outputs.set(name, value),
      log: {
        info: vi.fn(),
        notice: vi.fn(),
        group: async (_: string, run: () => Promise<unknown>) => run(),
      },
    } as never,
  };
};

const run = async (
  fake: ReturnType<typeof fakeCli>,
  overrides: Record<string, string> = {},
) => {
  const harness = deps(fake.cli);
  const result = await runAction(harness.deps, env(overrides), event);
  return { ...harness, result: result as { body: string } };
};

describe("a preview with ios-submit", () => {
  it("asks for the sandbox scheme's own channel: no --channel, ever", async () => {
    const fake = fakeCli();
    await run(fake);
    const finds = fake.calls.filter(
      ([command, sub]) => command === "native-build" && sub === "find",
    );
    expect(finds.length).toBeGreaterThan(0);
    for (const find of finds) expect(find).not.toContain("-c");
  });

  it("uploads with no matching build, and deploys to the pull request's channel", async () => {
    const fake = fakeCli();
    const { outputs, result } = await run(fake, {
      INPUT_IOS_TESTFLIGHT_GROUP: "QA",
    });

    const build = fake.calls.find(([, sub]) => sub === "ios")!;
    expect(build).toEqual([
      "native-build",
      "ios",
      "--scheme",
      "sandbox",
      "--submit",
      "testflight",
      "--testflight-group",
      "QA",
      "--what-to-test",
      "Native build for #12. Pull requests with the same native code reuse it.",
      "--json",
    ]);
    const deploy = fake.calls.find(([command]) => command === "deploy")!;
    expect(deploy.slice(0, 5)).toEqual(["deploy", "-p", "ios", "-c", "pr-12"]);
    expect(outputs.get("ios-store-url")).toBe(TESTFLIGHT_URL);
    expect(outputs.get("ios-store-state")).toBe("processing");
    expect(outputs.get("ios-install-url")).toBe(TESTFLIGHT_URL);
    expect(result.body).toContain(`[TestFlight](${TESTFLIGHT_URL})`);
    expect(result.body).toContain("processing");
    expect(result.body).not.toContain("api/native-builds");
    expect(result.body).toContain("Details");
  });

  it("uploads nothing when the store offers the build for this fingerprint", async () => {
    const fake = fakeCli({ found: row(true), foundStore: store("ready") });
    const { outputs, result } = await run(fake);

    expect(
      fake.words().filter((call) => call.startsWith("native-build ios")),
    ).toEqual([]);
    expect(fake.words()).toContain("fingerprint create");
    const deploy = fake.calls.find(([command]) => command === "deploy")!;
    expect(deploy.slice(0, 5)).toEqual(["deploy", "-p", "ios", "-c", "pr-12"]);
    expect(outputs.get("ios-store-state")).toBe("ready");
    expect(result.body).toContain("ready to install");
    expect(result.body).toContain("reused");
  });

  it("reuses a build whose store can't be read, as its record says", async () => {
    const fake = fakeCli({
      found: row(true),
      foundStore: {
        ...store("ready"),
        url: null,
        state: null,
      } as never,
    });
    const { outputs } = await run(fake);
    expect(
      fake.words().filter((call) => call.startsWith("native-build ios")),
    ).toEqual([]);
    expect(outputs.get("ios-store-url")).toBe("");
    expect(outputs.get("ios-store-state")).toBe("");
  });

  it("uploads through the cache when a tracked build isn't on the store yet", async () => {
    const fake = fakeCli({ found: row(false) });
    await run(fake);
    const build = fake.calls.find(([, sub]) => sub === "ios")!;
    expect(build).toContain("--submit");
    expect(build).not.toContain("--no-cache");
  });

  it.each([
    ["expired", store("expired", false)],
    ["replaced", store("replaced", false)],
    ["about to expire", store("ready", false)],
  ])(
    "builds anew, past the cache, when the build is %s",
    async (_, foundStore) => {
      const fake = fakeCli({ found: row(true), foundStore });
      await run(fake);
      const build = fake.calls.find(([, sub]) => sub === "ios")!;
      expect(build).toContain("--no-cache");
      expect(build).toContain("--submit");
    },
  );

  it("fails, deploying nothing, when the store's build may be another one", async () => {
    const fake = fakeCli({
      submission: {
        destination: "testflight",
        skipped: "already-submitted",
        existing: { version: "1.7.0 (66)", source: "store" },
        store: null,
      },
    });
    await expect(run(fake)).rejects.toThrow(
      "TestFlight already has 1.7.0 (66), which may be another build. Push again for a new number.",
    );
    expect(fake.calls.some(([command]) => command === "deploy")).toBe(false);
  });

  it("refuses a normal scheme before it builds or deploys anything", async () => {
    const fake = fakeCli({ channel: "pr-12" });
    await expect(run(fake)).rejects.toThrow(
      "ios-submit takes a sandbox scheme, and sandbox isn't one.\nSet sandbox: true on it, or remove ios-submit.",
    );
    expect(fake.calls.some(([, sub]) => sub === "ios")).toBe(false);
    expect(fake.calls.some(([command]) => command === "deploy")).toBe(false);
  });

  it("fails when the build embeds another channel", async () => {
    const fake = fakeCli({ builtChannel: "production" });
    await expect(run(fake)).rejects.toThrow(
      "embeds the production channel, not sandbox-sandbox",
    );
    expect(fake.calls.some(([command]) => command === "deploy")).toBe(false);
  });

  it("keeps the store build on the closed pull request's cleanup", async () => {
    const fake = fakeCli();
    fake.cli.mockImplementation(async (args: string[]) => {
      fake.calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({
          channel: "pr-12",
          deleted: true,
          deletedBundleIds: ["bundle-1"],
          deletedNativeBuildIds: [],
        }),
      };
    });
    const harness = deps(fake.cli);
    await runAction(harness.deps, env(), { ...event, action: "closed" });
    expect(fake.words()).toEqual([
      "channel delete pr-12 --native-builds --yes --json",
    ]);
  });
});

describe("a reused build with ios-testflight-group", () => {
  const withGroup = { INPUT_IOS_TESTFLIGHT_GROUP: "QA" };
  const groupCalls = (fake: ReturnType<typeof fakeCli>) =>
    fake.calls.filter(([, sub]) => sub === "testflight-group");

  it("applies the group with no upload, reading the store's word only there", async () => {
    const fake = fakeCli({ found: row(true) });
    const { outputs, result } = await run(fake, withGroup);

    expect(groupCalls(fake)).toEqual([
      [
        "native-build",
        "testflight-group",
        "build-1",
        "QA",
        "--scheme",
        "sandbox",
        "--json",
      ],
    ]);
    // One read of the store: the group's command replaces --store-status.
    expect(fake.words().some((call) => call.includes("--store-status"))).toBe(
      false,
    );
    expect(fake.calls.some(([, sub]) => sub === "ios")).toBe(false);
    expect(fake.calls.some(([command]) => command === "deploy")).toBe(true);
    expect(outputs.get("ios-store-state")).toBe("ready");
    expect(result.body).toContain("reused");
  });

  it("fails, deploying nothing, when the group can't be applied", async () => {
    const fake = fakeCli({ found: row(true), groupFails: true });
    await expect(run(fake, withGroup)).rejects.toThrow(
      "native-build testflight-group build-1 QA --scheme sandbox --json exited with 1",
    );
    expect(fake.calls.some(([command]) => command === "deploy")).toBe(false);
    expect(fake.calls.some(([, sub]) => sub === "ios")).toBe(false);
  });

  it("says a build still processing joins on the next run, and deploys", async () => {
    const fake = fakeCli({
      found: row(true),
      groupStore: { ...store("processing"), group: "pending" },
    });
    const harness = deps(fake.cli);
    await runAction(harness.deps, env(withGroup), event);
    const { notice } = (
      harness.deps as unknown as {
        log: { notice: ReturnType<typeof vi.fn> };
      }
    ).log;
    expect(notice).toHaveBeenCalledWith(
      "QA doesn't have build build-1 yet: App Store Connect is still processing it. The next run adds it.",
    );
    expect(fake.calls.some(([command]) => command === "deploy")).toBe(true);
    expect(harness.outputs.get("ios-store-state")).toBe("processing");
  });

  it("builds anew, naming the group, when testers can't get the build", async () => {
    const fake = fakeCli({
      found: row(true),
      groupStore: { ...store("expired", false), group: "not-offered" },
    });
    await run(fake, withGroup);
    const build = fake.calls.find(([, sub]) => sub === "ios")!;
    expect(build).toContain("--no-cache");
    expect(build).toContain("--testflight-group");
  });

  it("applies no group to a build the store never took: its upload does", async () => {
    const fake = fakeCli({ found: row(false) });
    await run(fake, withGroup);
    expect(groupCalls(fake)).toEqual([]);
    expect(fake.calls.find(([, sub]) => sub === "ios")).toContain(
      "--testflight-group",
    );
  });

  it("runs no group command without the input", async () => {
    const fake = fakeCli({ found: row(true), foundStore: store("ready") });
    await run(fake);
    expect(groupCalls(fake)).toEqual([]);
    expect(fake.words()[1]).toContain("--store-status");
  });
});

describe("parseInputs", () => {
  it.each([
    ["ios", "app-store", "ios-submit takes testflight, not app-store"],
    ["ios", "play-internal", "ios-submit takes testflight, not play-internal"],
    [
      "android",
      "production",
      "android-submit takes play-internal, not production",
    ],
    ["android", "alpha", "android-submit takes play-internal, not alpha"],
    ["android", "beta", "android-submit takes play-internal, not beta"],
    [
      "android",
      "testflight",
      "android-submit takes play-internal, not testflight",
    ],
  ])(
    "refuses %s-submit %s before the CLI runs",
    (platform, submit, message) => {
      expect(() =>
        parseInputs(
          env({
            INPUT_PLATFORMS: platform,
            INPUT_ANDROID_SCHEME: "sandbox",
            [`INPUT_${platform.toUpperCase()}_SUBMIT`]: submit,
            ...(platform === "android" ? { INPUT_IOS_SUBMIT: "" } : {}),
          }),
          event,
        ),
      ).toThrow(message);
    },
  );

  it("refuses a group without ios-submit", () => {
    expect(() =>
      parseInputs(
        env({ INPUT_IOS_SUBMIT: "", INPUT_IOS_TESTFLIGHT_GROUP: "QA" }),
        event,
      ),
    ).toThrow("ios-testflight-group goes with ios-submit: testflight.");
  });

  it("sets no store when no input asks for one", () => {
    const inputs = parseInputs(
      {
        INPUT_CONSOLE_URL: "https://console.example.com",
        INPUT_ANDROID_SCHEME: "releaseApk",
      },
      event,
    );
    expect(inputs.submits).toEqual({});
    expect(inputs.testFlightGroup).toBeNull();
  });
});

describe("a preview with no store input", () => {
  it("sets no store output and adds nothing to the previews output", async () => {
    const fake = fakeCli({ channel: "pr-12", builtChannel: "pr-12" });
    const harness = deps(fake.cli);
    await runAction(
      harness.deps,
      {
        INPUT_CONSOLE_URL: "https://console.example.com",
        INPUT_PLATFORMS: "android",
        INPUT_ANDROID_SCHEME: "releaseApk",
        INPUT_COMMENT: "false",
      },
      event,
    );
    expect(
      [...harness.outputs.keys()].filter((name) => name.includes("store")),
    ).toEqual([]);
    const [preview] = JSON.parse(harness.outputs.get("previews")!);
    expect(preview).not.toHaveProperty("store");
    const finds = fake.calls.filter(([, sub]) => sub === "find");
    // The build's lookup asks what the project embeds, and the download's names
    // the pull request's channel.
    expect(finds.at(-1)).toContain("-c");
    for (const find of finds) expect(find).not.toContain("--store-status");
  });
});
