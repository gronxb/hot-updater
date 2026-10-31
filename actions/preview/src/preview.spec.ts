import { describe, expect, it, vi } from "vitest";

import { COMMENT_MARKER } from "./comment.mjs";
import { parseInputs, parseJsonOutput, runAction } from "./preview.mjs";

const event = {
  action: "synchronize",
  number: 12,
  title: "Fix the header",
  headSha: "0123456789abcdef",
  fromFork: false,
};

const env = (overrides: Record<string, string> = {}) => ({
  INPUT_CONSOLE_URL: "https://console.example.com",
  INPUT_PLATFORMS: "android",
  INPUT_ANDROID_SCHEME: "releaseApk",
  INPUT_IOS_SCHEME: "simulator",
  INPUT_COMMENT: "false",
  ...overrides,
});

type Build = {
  id: string;
  platform: string;
  channel: string;
  fingerprintHash: string | null;
  appVersion: string | null;
  kind: string;
};

/** Where a build's artifact is stored, as `native-build` uploads it. */
const artifactUri = (build: Build) =>
  `s3://bucket/native-builds/${build.platform}/${build.id}/${build.kind === "apk" ? "app-release.apk" : "App.app.zip"}`;

/**
 * The Console's QR code route, as a public Console answers the runner: the
 * download URL under the Console's own address.
 */
const consoleFetch = async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const build = url.searchParams.get("build")!;
  return new Response(null, {
    status: 200,
    headers: {
      "x-hot-updater-download-url": `${url.origin}/api/native-builds/${build}/download`,
    },
  });
};

/**
 * The project's CLI over a registry and a channel's bundles, as the commands
 * the action runs answer: `native-build <platform>` tracks a build of the project's
 * target, `deploy` deploys a bundle of it.
 */
const fakeCli = ({
  target = { fingerprintHash: "fp-a", appVersion: null },
  builds = [] as Build[],
  builtChannel,
  builtTarget,
  builtDebug = false,
  buildFails = false,
  downloadUrl = (build) => `https://storage.example.com/${build.id}?sig=1`,
  findFailsAfterBuild = false,
  foundAfterBuild,
  channelDelete = {
    code: 0,
    json: {
      channel: "pr-12",
      deleted: true,
      deletedBundleIds: ["b1", "b2"],
      deletedNativeBuildIds: ["build-1"],
    } as Record<string, unknown>,
  },
}: {
  target?: { fingerprintHash: string | null; appVersion: string | null };
  builds?: Build[];
  /** The channel a build embeds, when it isn't the one set. */
  builtChannel?: string;
  /** What a build's artifact embeds, when it isn't the project's target. */
  builtTarget?: { fingerprintHash: string | null; appVersion: string | null };
  /** The scheme builds Debug, which the CLI does not track. */
  builtDebug?: boolean;
  /** Whether `native-build <platform>` fails, as a failed native build exits. */
  buildFails?: boolean;
  /** The URL `native-build find` prints for a build; null when the storage has none. */
  downloadUrl?: (build: Build) => string | null;
  /** Whether `native-build find` fails once a build is tracked. */
  findFailsAfterBuild?: boolean;
  /** The build `native-build find` matches once a build is tracked. */
  foundAfterBuild?: Build;
  channelDelete?: { code: number; json: Record<string, unknown> };
} = {}) => {
  const calls: string[] = [];
  const releases: {
    id: string;
    channel: string;
    platform: string;
    targetAppVersion: string | null;
  }[] = [];
  let channel = "production";
  let counter = 0;
  const cli = vi.fn(async (args: string[], options?: { capture?: boolean }) => {
    calls.push(args.join(" "));
    const [command, sub] = args;
    const flag = (name: string) => args[args.indexOf(name) + 1]!;
    if (command === "channel" && sub === "set") {
      channel = args[2]!;
      return { code: 0, stdout: "" };
    }
    if (command === "native-build" && sub === "find") {
      if (findFailsAfterBuild && builds.length > 0) {
        return { code: 1, stdout: "" };
      }
      const scope = {
        platform: flag("-p"),
        channel: flag("-c"),
        ...target,
      };
      const found =
        (counter > 0 ? foundAfterBuild : undefined) ??
        builds
          .filter(
            (build) =>
              build.platform === scope.platform &&
              build.channel === scope.channel &&
              build.fingerprintHash === scope.fingerprintHash &&
              build.appVersion === scope.appVersion,
          )
          .at(-1) ??
        null;
      return {
        code: 0,
        // A config that logs while it loads.
        stdout: `loading config\n${JSON.stringify(
          {
            ...scope,
            nativeBuild: found && {
              id: found.id,
              artifact_kind: found.kind,
              artifact_storage_uri: artifactUri(found),
            },
            downloadUrl: found && downloadUrl(found),
          },
          null,
          2,
        )}\n`,
      };
    }
    if (command === "native-build" && (sub === "ios" || sub === "android")) {
      if (buildFails) return { code: 1, stdout: "" };
      const platform = sub;
      const build = {
        id: `build-${++counter}`,
        platform,
        channel: builtChannel ?? channel,
        ...(builtTarget ?? target),
        kind: platform === "android" ? "apk" : "app",
      };
      builds.push(build);
      return {
        code: 0,
        // The build's own output, then the JSON line.
        stdout: `[CXX1100] building\n{ not json\n${JSON.stringify({
          build: {
            channel: build.channel,
            fingerprintHash: build.fingerprintHash,
            appVersion: build.appVersion,
          },
          nativeBuild: builtDebug
            ? null
            : {
                id: build.id,
                artifact_kind: build.kind,
                artifact_storage_uri: artifactUri(build),
              },
          registration: { skipped: builtDebug ? "debug" : null },
        })}\n`,
      };
    }
    if (command === "deploy") {
      releases.push({
        id: `bundle-${++counter}`,
        channel: flag("-c"),
        platform: flag("-p"),
        targetAppVersion: args.includes("-t") ? flag("-t") : null,
      });
      return { code: 0, stdout: "" };
    }
    if (command === "bundle" && sub === "list") {
      const rows = releases
        .filter(
          (release) =>
            release.channel === flag("-c") && release.platform === flag("-p"),
        )
        .reverse()
        .map(({ id, targetAppVersion }) => ({
          id,
          fingerprint_hash: (builtTarget ?? target).fingerprintHash,
          target_app_version: targetAppVersion,
        }));
      return { code: 0, stdout: JSON.stringify(rows, null, 2) };
    }
    if (command === "channel" && sub === "delete") {
      return {
        code: channelDelete.code,
        stdout: JSON.stringify(channelDelete.json, null, 2),
      };
    }
    if (command === "fingerprint" && sub === "create") {
      return { code: 0, stdout: "" };
    }
    throw new Error(`unexpected command ${args.join(" ")} ${options}`);
  });
  return { cli, calls, builds, releases };
};

const deps = (
  cli: ReturnType<typeof fakeCli>["cli"],
  overrides: Partial<Parameters<typeof runAction>[0]> = {},
) => {
  const outputs: Record<string, string> = {};
  const value = {
    cli,
    buildLogs: vi.fn((_since: number): string[] => []),
    fetch: vi.fn(consoleFetch) as unknown as typeof fetch,
    github: null,
    setOutput: (name: string, output: string) => {
      outputs[name] = output;
    },
    log: {
      info: vi.fn(),
      notice: vi.fn(),
      group: <T>(_: string, run: () => Promise<T>) => run(),
    },
    ...overrides,
  };
  return { deps: value, outputs };
};

describe("runAction preview", () => {
  it("sets a failed build's log as the platform's build-log output", async () => {
    const logFile = "/work/.hot-updater/log/10261157-ios-simulator-build.log";
    const fake = fakeCli({ buildFails: true });
    const buildLogs = vi.fn((_since: number) => [logFile]);
    const { deps: d, outputs } = deps(fake.cli, { buildLogs });

    await expect(
      runAction(d, env({ INPUT_PLATFORMS: "ios" }), event),
    ).rejects.toThrow("hot-updater native-build ios");

    expect(outputs).toEqual({ "ios-build-log": logFile });
    expect(d.log.info).toHaveBeenCalledWith(`Build log: ${logFile}`);
    expect(buildLogs).toHaveBeenCalledTimes(1);
    // Nothing deploys after the build fails.
    expect(fake.calls.some((call) => call.startsWith("deploy"))).toBe(false);
  });

  it("builds and registers a native build when none has the project's fingerprint, then deploys to the pull request's channel", async () => {
    const fake = fakeCli();
    const { deps: d, outputs } = deps(fake.cli);

    await runAction(d, env(), event);

    expect(fake.calls).toEqual([
      "channel set pr-12",
      "native-build find -p android -c pr-12 -s releaseApk --json",
      "native-build android --scheme releaseApk --json",
      "deploy -p android -c pr-12 -m #12 Fix the header",
      "bundle list -c pr-12 -p android --limit 1 --json",
      // The build's own output has no download URL.
      "native-build find -p android -c pr-12 -s releaseApk --json",
    ]);
    expect(JSON.parse(outputs["previews"]!)).toEqual([
      {
        platform: "android",
        target: { fingerprintHash: "fp-a", appVersion: null },
        nativeBuild: {
          id: "build-1",
          artifactKind: "apk",
          fileName: "app-release.apk",
        },
        built: true,
        bundleId: "bundle-2",
        installUrl:
          "https://console.example.com/api/native-builds/build-1/download",
        downloadUrl: "https://storage.example.com/build-1?sig=1",
      },
    ]);
    expect(outputs["comment-body"]).toContain(
      "[Download](https://console.example.com/api/native-builds/build-1/download) · [Details](https://console.example.com/native-builds/build-1) · built for this commit",
    );
  });

  it("deploys only the bundle when a native build has the project's fingerprint on the pull request's channel", async () => {
    const fake = fakeCli({
      builds: [
        {
          id: "build-0",
          platform: "android",
          channel: "pr-12",
          fingerprintHash: "fp-a",
          appVersion: null,
          kind: "apk",
        },
      ],
    });
    const { deps: d, outputs } = deps(fake.cli);

    await runAction(d, env(), event);

    expect(fake.calls).toEqual([
      "channel set pr-12",
      "native-build find -p android -c pr-12 -s releaseApk --json",
      // fingerprint.json may be older than the project.
      "fingerprint create",
      "deploy -p android -c pr-12 -m #12 Fix the header",
      "bundle list -c pr-12 -p android --limit 1 --json",
    ]);
    expect(
      fake.calls.some((call) => /^native-build (ios|android) /.test(call)),
    ).toBe(false);
    expect(JSON.parse(outputs["previews"]!)[0]).toMatchObject({
      nativeBuild: { id: "build-0" },
      built: false,
    });
    expect(outputs["comment-body"]).toContain(
      "[Download](https://console.example.com/api/native-builds/build-0/download) · [Details](https://console.example.com/native-builds/build-0) · reused",
    );
  });

  it.each([
    ["another fingerprint", { channel: "pr-12", fingerprintHash: "fp-b" }],
    // Another pull request's build embeds that pull request's channel.
    ["another channel", { channel: "pr-11", fingerprintHash: "fp-a" }],
  ])("builds again when the registered build has %s", async (_, build) => {
    const fake = fakeCli({
      builds: [
        {
          id: "build-0",
          platform: "android",
          appVersion: null,
          kind: "apk",
          ...build,
        },
      ],
    });
    const { deps: d } = deps(fake.cli);

    await runAction(d, env(), event);

    expect(fake.calls).toContain(
      "native-build android --scheme releaseApk --json",
    );
  });

  it("deploys to the app version of the build with the appVersion strategy, without rewriting fingerprint.json", async () => {
    const fake = fakeCli({
      target: { fingerprintHash: null, appVersion: "1.4.0" },
      builds: [
        {
          id: "build-0",
          platform: "android",
          channel: "pr-12",
          fingerprintHash: null,
          appVersion: "1.4.0",
          kind: "apk",
        },
      ],
    });
    const { deps: d } = deps(fake.cli);

    await runAction(d, env(), event);

    expect(fake.calls).toEqual([
      "channel set pr-12",
      "native-build find -p android -c pr-12 -s releaseApk --json",
      "deploy -p android -c pr-12 -m #12 Fix the header -t 1.4.0",
      "bundle list -c pr-12 -p android --limit 1 --json",
    ]);
  });

  it("deploys to the version the build's artifact embeds, such as an xcconfig's, not the project's", async () => {
    const fake = fakeCli({
      target: { fingerprintHash: null, appVersion: "1.4.0" },
      builtTarget: { fingerprintHash: null, appVersion: "2.0.0" },
    });
    const { deps: d, outputs } = deps(fake.cli);

    await runAction(d, env(), event);

    expect(fake.calls).toContain(
      "deploy -p android -c pr-12 -m #12 Fix the header -t 2.0.0",
    );
    expect(JSON.parse(outputs["previews"]!)[0]).toMatchObject({
      target: { fingerprintHash: null, appVersion: "2.0.0" },
      nativeBuild: { id: "build-1" },
      built: true,
    });
  });

  it("fails without deploying when the build embeds another channel than the pull request's", async () => {
    // An Expo project whose config plugin ignores the job's PREVIEW_CHANNEL.
    const fake = fakeCli({ builtChannel: "production" });
    const { deps: d } = deps(fake.cli);

    await expect(runAction(d, env(), event)).rejects.toThrow(
      "native-build android built a native build that embeds the production channel, not pr-12.",
    );
    expect(fake.calls.some((call) => call.startsWith("deploy"))).toBe(false);
  });

  it("fails without deploying when the preview scheme builds Debug, which Hot Updater does not track", async () => {
    const fake = fakeCli({ builtDebug: true });
    const { deps: d } = deps(fake.cli);

    await expect(runAction(d, env(), event)).rejects.toThrow(
      "The android-scheme releaseApk builds Debug, which Hot Updater does not track, so a preview can't install it: use a Release scheme.",
    );
    expect(fake.calls.some((call) => call.startsWith("deploy"))).toBe(false);
  });

  it("fails when the deployed bundle targets another fingerprint than the build", async () => {
    const fake = fakeCli({
      builds: [
        {
          id: "build-0",
          platform: "android",
          channel: "pr-12",
          fingerprintHash: "fp-a",
          appVersion: null,
          kind: "apk",
        },
      ],
    });
    const cli = vi.fn(
      async (args: string[], options?: { capture?: boolean }) => {
        const result = await fake.cli(args, options);
        return args[0] === "bundle"
          ? {
              code: 0,
              stdout: JSON.stringify([
                {
                  id: "bundle-9",
                  fingerprint_hash: "fp-z",
                  target_app_version: null,
                },
              ]),
            }
          : result;
      },
    );
    const { deps: d } = deps(cli);

    await expect(runAction(d, env(), event)).rejects.toThrow(
      "The android bundle bundle-9 targets fp-z, but the native build has fingerprint fp-a.",
    );
  });

  it("fails when the deployed bundle targets another app version than the build", async () => {
    const fake = fakeCli({
      target: { fingerprintHash: null, appVersion: "1.4.0" },
      builds: [
        {
          id: "build-0",
          platform: "android",
          channel: "pr-12",
          fingerprintHash: null,
          appVersion: "1.4.0",
          kind: "apk",
        },
      ],
    });
    const cli = vi.fn(
      async (args: string[], options?: { capture?: boolean }) => {
        const result = await fake.cli(args, options);
        return args[0] === "bundle"
          ? {
              code: 0,
              stdout: JSON.stringify([
                {
                  id: "bundle-9",
                  fingerprint_hash: null,
                  target_app_version: "1.x.x",
                },
              ]),
            }
          : result;
      },
    );
    const { deps: d } = deps(cli);

    await expect(runAction(d, env(), event)).rejects.toThrow(
      "The android bundle bundle-9 targets 1.x.x, but the native build has app version 1.4.0.",
    );
  });

  it("previews each platform in order, in one comment", async () => {
    const fake = fakeCli();
    const { deps: d, outputs } = deps(fake.cli);

    await runAction(d, env({ INPUT_PLATFORMS: "android, ios" }), event);

    expect(
      fake.calls.filter((call) => /^native-build (ios|android) /.test(call)),
    ).toEqual([
      "native-build android --scheme releaseApk --json",
      "native-build ios --scheme simulator --json",
    ]);
    expect(outputs["comment-body"]).toContain("| Android |");
    expect(outputs["comment-body"]).toContain("| iOS Simulator |");
  });

  it("shows the Console's QR code of an APK's download, which the runner checked", async () => {
    const fake = fakeCli();
    const { deps: d, outputs } = deps(fake.cli);

    await runAction(d, env({ INPUT_PLATFORMS: "android, ios" }), event);

    // Only the APK has a QR code: a simulator app installs on a computer.
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(d.fetch).toHaveBeenCalledWith(
      "https://console.example.com/_hot-updater/native-builds/qr?build=build-1",
      { method: "HEAD" },
    );
    const body = outputs["comment-body"]!;
    expect(body).toContain(
      '<img src="https://console.example.com/_hot-updater/native-builds/qr?build=build-1"',
    );
    expect(body).not.toContain("qr?build=build-3");
    expect(body).toContain("adb install -r app-release.apk");
    expect(body).toContain("npx hot-updater native-build install build-3");
    expect(body).not.toContain("xcrun simctl");
    expect(d.log.notice).not.toHaveBeenCalled();
  });

  it.each([
    [
      "is unreachable",
      async () => {
        throw new TypeError("fetch failed");
      },
      "No QR code in the comment: the Console is unreachable from the runner (fetch failed).",
    ],
    [
      "answers an error",
      async () => new Response("", { status: 404 }),
      "No QR code in the comment: the Console answered 404 to https://console.example.com/_hot-updater/native-builds/qr?build=build-1.",
    ],
    [
      // A Console behind a proxy that sees another address than the runner.
      "holds another address",
      async () =>
        new Response(null, {
          headers: {
            "x-hot-updater-download-url":
              "http://10.0.0.2:3000/api/native-builds/build-1/download",
          },
        }),
      "No QR code in the comment: the QR code at https://console.example.com/_hot-updater/native-builds/qr?build=build-1 holds http://10.0.0.2:3000/api/native-builds/build-1/download, not https://console.example.com/api/native-builds/build-1/download.",
    ],
  ])(
    "links the download without a QR code when the Console %s",
    async (_, answer, notice) => {
      const fake = fakeCli();
      const { deps: d, outputs } = deps(fake.cli, {
        fetch: vi.fn(answer) as unknown as typeof fetch,
      });

      await runAction(d, env(), event);

      const body = outputs["comment-body"]!;
      expect(body).not.toContain("<img");
      expect(body).toContain(
        "[Download](https://console.example.com/api/native-builds/build-1/download)",
      );
      expect(d.log.notice).toHaveBeenCalledWith(notice);
    },
  );

  describe("install and download outputs", () => {
    const reusable = (id: string, platform: string, kind: string): Build => ({
      id,
      platform,
      channel: "pr-12",
      fingerprintHash: "fp-a",
      appVersion: null,
      kind,
    });

    it("sets each platform's outputs: the Console link for an APK, the command for a simulator build", async () => {
      const fake = fakeCli();
      const { deps: d, outputs } = deps(fake.cli);

      await runAction(d, env({ INPUT_PLATFORMS: "android, ios" }), event);

      expect(outputs).toMatchObject({
        "android-install-url":
          "https://console.example.com/api/native-builds/build-1/download",
        "android-download-url": "https://storage.example.com/build-1?sig=1",
        "ios-install-url": "npx hot-updater native-build install build-3",
        "ios-download-url": "https://storage.example.com/build-3?sig=1",
      });
    });

    it("sets only the previewed platform's outputs", async () => {
      const { deps: d, outputs } = deps(fakeCli().cli);

      await runAction(d, env(), event);

      expect(outputs).not.toHaveProperty("ios-install-url");
      expect(outputs).not.toHaveProperty("ios-download-url");
    });

    it("reads a reused build's URL from the first lookup, with no other read", async () => {
      const fake = fakeCli({
        builds: [reusable("build-0", "android", "apk")],
      });
      const { deps: d, outputs } = deps(fake.cli);

      await runAction(d, env(), event);

      expect(
        fake.calls.filter((call) => call.startsWith("native-build find")),
      ).toHaveLength(1);
      expect(outputs["android-download-url"]).toBe(
        "https://storage.example.com/build-0?sig=1",
      );
    });

    it("sets an empty download-url and a null downloadUrl when the storage gives no URL, and keeps the install link", async () => {
      const fake = fakeCli({
        builds: [reusable("build-0", "android", "apk")],
        downloadUrl: () => null,
      });
      const { deps: d, outputs } = deps(fake.cli);

      await runAction(d, env(), event);

      expect(outputs["android-download-url"]).toBe("");
      expect(outputs["android-install-url"]).toBe(
        "https://console.example.com/api/native-builds/build-0/download",
      );
      expect(JSON.parse(outputs["previews"]!)[0]).toMatchObject({
        downloadUrl: null,
        installUrl:
          "https://console.example.com/api/native-builds/build-0/download",
      });
    });

    it("sets an empty download-url when a built build's storage gives no URL", async () => {
      const fake = fakeCli({ downloadUrl: () => null });
      const { deps: d, outputs } = deps(fake.cli);

      await runAction(d, env(), event);

      expect(outputs["android-download-url"]).toBe("");
      expect(d.log.notice).not.toHaveBeenCalled();
    });

    it("never takes another build's URL when the lookup after a build finds another one", async () => {
      // A scheme that sets its version at build time: the lookup reads the
      // project's version, which an older build has.
      const fake = fakeCli({
        foundAfterBuild: reusable("older", "android", "apk"),
      });
      const { deps: d, outputs } = deps(fake.cli);

      await runAction(d, env(), event);

      expect(JSON.parse(outputs["previews"]!)[0]).toMatchObject({
        nativeBuild: { id: "build-1" },
        downloadUrl: null,
      });
      expect(outputs["android-download-url"]).toBe("");
      expect(d.log.notice).toHaveBeenCalledWith(
        "No android-download-url: native-build find didn't match build-1.",
      );
    });

    it("keeps a deployed preview when the lookup after its build fails", async () => {
      const fake = fakeCli({ findFailsAfterBuild: true });
      const { deps: d, outputs } = deps(fake.cli);

      await runAction(d, env(), event);

      expect(outputs["android-download-url"]).toBe("");
      expect(outputs["android-install-url"]).toBe(
        "https://console.example.com/api/native-builds/build-1/download",
      );
      expect(outputs["comment-body"]).toContain("| Android |");
      expect(d.log.notice).toHaveBeenCalledWith(
        "No android-download-url: hot-updater native-build find -p android -c pr-12 -s releaseApk --json exited with 1.",
      );
    });

    it("keeps the storage URL out of the comment and the job's log", async () => {
      const secret = "https://storage.example.com/private?sig=secret";
      const fake = fakeCli({ downloadUrl: () => secret });
      const { deps: d, outputs } = deps(fake.cli);

      await runAction(d, env({ INPUT_PLATFORMS: "android, ios" }), event);

      expect(outputs["comment-body"]).not.toContain("storage.example.com");
      const logged = [
        ...vi.mocked(d.log.info).mock.calls,
        ...vi.mocked(d.log.notice).mock.calls,
      ].flat();
      expect(logged.join("\n")).not.toContain("storage.example.com");
      // The lookup that prints it tells the CLI wrapper not to echo it.
      for (const [args, options] of fake.cli.mock.calls) {
        if (args[1] === "find") expect(options).toMatchObject({ quiet: true });
      }
    });

    it("leaves the outputs a cleanup doesn't have unset", async () => {
      const { deps: d, outputs } = deps(fakeCli().cli);

      await runAction(d, env(), { ...event, action: "closed" });

      expect(Object.keys(outputs)).toEqual(["comment-body"]);
    });
  });

  it("shows no channel link anywhere", async () => {
    const fake = fakeCli();
    const { deps: d, outputs } = deps(fake.cli);

    await runAction(d, env({ INPUT_PLATFORMS: "android, ios" }), event);

    expect(outputs["comment-body"]).not.toMatch(
      /hot-updater\/channel\/|openurl|am start|channelLinkPrefix/,
    );
    expect(fake.calls.some((call) => call.startsWith("channel link"))).toBe(
      false,
    );
  });

  it("writes the comment to the pull request", async () => {
    const fake = fakeCli();
    const github = {
      fetch: vi.fn(),
      apiUrl: "https://api.github.com",
      repository: "o/r",
      token: "t",
    };
    github.fetch
      // GITHUB_TOKEN can't read GET /user.
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ id: 5 }, { status: 201 }));
    const { deps: d, outputs } = deps(fake.cli, {
      github: github as unknown as Parameters<typeof runAction>[0]["github"],
    });

    await runAction(d, env({ INPUT_COMMENT: "true" }), event);

    expect(github.fetch).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/o/r/issues/12/comments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body: outputs["comment-body"] }),
      }),
    );
  });

  it("skips everything for a pull request from a fork, which gets no secrets", async () => {
    const fake = fakeCli();
    const { deps: d } = deps(fake.cli);

    await expect(
      runAction(d, env(), { ...event, fromFork: true }),
    ).resolves.toEqual({ skipped: true });
    expect(fake.cli).not.toHaveBeenCalled();
    expect(d.log.notice).toHaveBeenCalled();
  });
});

describe("runAction cleanup", () => {
  const closed = { ...event, action: "closed" };

  it("deletes the closed pull request's channel and edits its comment", async () => {
    const fake = fakeCli();
    const github = {
      fetch: vi.fn(),
      apiUrl: "https://api.github.com",
      repository: "o/r",
      token: "t",
    };
    github.fetch
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 9,
            body: `${COMMENT_MARKER}\n\n### Preview`,
            user: { login: "github-actions[bot]", type: "Bot" },
          },
        ]),
      )
      .mockResolvedValueOnce(Response.json({ id: 9 }));
    const { deps: d, outputs } = deps(fake.cli, {
      github: github as unknown as Parameters<typeof runAction>[0]["github"],
    });

    await runAction(d, env({ INPUT_COMMENT: "true" }), closed);

    expect(fake.calls).toEqual([
      "channel delete pr-12 --native-builds --yes --json",
    ]);
    expect(outputs["comment-body"]).toContain(
      "its channel `pr-12`, its 2 bundles, and its 1 native build are deleted.",
    );
    expect(github.fetch).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/o/r/issues/comments/9",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("needs no scheme, and comments nothing on a pull request it never previewed", async () => {
    const fake = fakeCli({
      channelDelete: {
        code: 0,
        json: { channel: "pr-12", deleted: false, reason: "not_found" },
      },
    });
    const github = {
      fetch: vi.fn(),
      apiUrl: "https://api.github.com",
      repository: "o/r",
      token: "t",
    };
    github.fetch
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(Response.json([]));
    const { deps: d, outputs } = deps(fake.cli, {
      github: github as unknown as Parameters<typeof runAction>[0]["github"],
    });

    await runAction(
      d,
      env({ INPUT_COMMENT: "true", INPUT_ANDROID_SCHEME: "" }),
      closed,
    );

    expect(outputs["comment-body"]).toContain("is already deleted");
    expect(github.fetch).toHaveBeenCalledTimes(2);
    expect(
      github.fetch.mock.calls.map(([, init]) => init?.method ?? "GET"),
    ).toEqual(["GET", "GET"]);
  });

  it("fails when the channel is kept, after saying so", async () => {
    const fake = fakeCli({
      channelDelete: {
        code: 1,
        json: {
          channel: "pr-12",
          deleted: false,
          deletedBundleIds: ["b1"],
          deletedNativeBuildIds: ["build-1", "build-2"],
        },
      },
    });
    const { deps: d, outputs } = deps(fake.cli);

    await expect(runAction(d, env(), closed)).rejects.toThrow(
      "The pr-12 channel is kept: a bundle or a native build was added to it while the cleanup ran.",
    );
    expect(outputs["comment-body"]).toContain(
      "its 1 bundle and its 2 native builds are deleted, and its channel `pr-12` is kept",
    );
  });

  it("fails when the delete fails for another reason", async () => {
    const fake = fakeCli({
      channelDelete: { code: 1, json: { channel: "pr-12", deleted: true } },
    });
    const { deps: d } = deps(fake.cli);

    await expect(runAction(d, env(), closed)).rejects.toThrow("exited with 1");
  });

  it("runs on mode cleanup for an open pull request", async () => {
    const fake = fakeCli();
    const { deps: d } = deps(fake.cli);

    await runAction(d, env({ INPUT_MODE: "cleanup" }), event);

    expect(fake.calls).toEqual([
      "channel delete pr-12 --native-builds --yes --json",
    ]);
  });
});

describe("parseInputs", () => {
  it("defaults to Android and the pull request's own channel", () => {
    expect(parseInputs(env(), event)).toEqual({
      consoleUrl: "https://console.example.com",
      platforms: ["android"],
      schemes: { android: "releaseApk", ios: "simulator" },
      channel: "pr-12",
      credit: true,
      comment: false,
      mode: "preview",
    });
  });

  it.each([
    [{ INPUT_PLATFORMS: "web" }, "platforms takes android and ios, not web."],
    [{ INPUT_CONSOLE_URL: "" }, "console-url is required."],
    [{ INPUT_CONSOLE_URL: "console.example.com" }, "console-url must be"],
    [{ INPUT_CREDIT: "no" }, "credit must be true or false."],
    [{ INPUT_MODE: "deploy" }, "mode must be auto, preview, or cleanup."],
    [{ INPUT_ANDROID_SCHEME: "" }, "android-scheme is required"],
  ])("refuses %j", (overrides, message) => {
    expect(() => parseInputs(env(overrides), event)).toThrow(message);
  });

  it("turns the credit line off", () => {
    expect(parseInputs(env({ INPUT_CREDIT: "false" }), event).credit).toBe(
      false,
    );
  });
});

describe("parseJsonOutput", () => {
  it("reads JSON after lines a config printed", () => {
    expect(parseJsonOutput('[config] {not json\n{\n  "a": 1\n}\n')).toEqual({
      a: 1,
    });
  });

  it("fails on output with no JSON", () => {
    expect(() => parseJsonOutput("nothing")).toThrow("Expected JSON output");
  });
});
