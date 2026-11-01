import { describe, expect, it, vi } from "vitest";

import {
  createPreviewLink,
  parsePreviewLink,
} from "../../../packages/protocol/src/nativeArtifact/sandbox";
import { COMMENT_MARKER, previewLink, previewQrLink } from "./comment.mjs";
import { parseInputs, runAction } from "./preview.mjs";

const CONSOLE = "https://console.example.com";
const FINGERPRINT = "a".repeat(64);
const OLD_FINGERPRINT = "b".repeat(64);
const APP_ID = "com.Example.App_tv";
const LINK = `hu-sandbox-com-example-app-tv://hot-updater/preview?channel=pr-12&fingerprint=${FINGERPRINT}`;
const BUILD_ID = "019a0000-0000-7000-8000-00000000b001";
const MIN_BUNDLE_ID = "019a0000-0000-7000-8000-000000000010";

const event = {
  action: "synchronize",
  number: 12,
  title: "Fix the header",
  headSha: "0123456789abcdef",
  fromFork: false,
};

const env = (overrides: Record<string, string> = {}) => ({
  INPUT_CONSOLE_URL: CONSOLE,
  INPUT_PLATFORMS: "android",
  INPUT_ANDROID_SCHEME: "sandbox",
  INPUT_COMMENT: "false",
  ...overrides,
});

type Build = {
  id: string;
  platform: string;
  channel: string;
  fingerprintHash: string;
  kind: string;
  minBundleId?: string;
};

const SANDBOX_SCHEMES: Readonly<Record<string, string>> = { sandbox: APP_ID };

const row = (build: Build) => ({
  id: build.id,
  artifact_kind: build.kind,
  artifact_storage_uri: `s3://bucket/native-builds/${build.platform}/${build.id}/app-release.apk`,
  min_bundle_id: build.minBundleId ?? MIN_BUNDLE_ID,
});

/**
 * The project's CLI as the real one answers: `find` refuses another channel on
 * a sandbox scheme, a sandbox scheme's channel is its own, and any other scheme
 * embeds what `channel set` wrote. Only a sandbox scheme's result has `sandbox`.
 */
const fakeCli = ({
  fingerprintHash = FINGERPRINT,
  builds = [] as Build[],
  builtChannel = undefined as string | undefined,
  storeRow = undefined as Record<string, unknown> | undefined,
} = {}) => {
  const calls: string[] = [];
  let channel = "production";
  let counter = 0;
  const cli = vi.fn(async (args: string[]) => {
    calls.push(args.join(" "));
    const [command, sub] = args;
    const flag = (name: string) =>
      args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    if (command === "channel" && sub === "set") {
      channel = args[2]!;
      return { code: 0, stdout: "" };
    }
    if (command === "native-build" && sub === "find") {
      const scheme = flag("-s")!;
      const platform = flag("-p")!;
      const appId = SANDBOX_SCHEMES[scheme];
      const asked = flag("-c");
      if (appId && asked !== undefined && asked !== `sandbox-${scheme}`) {
        return { code: 1, stdout: "" };
      }
      const scope = appId ? `sandbox-${scheme}` : (asked ?? channel);
      const onChannel = builds.filter(
        (build) => build.platform === platform && build.channel === scope,
      );
      const found =
        onChannel.findLast(
          (build) => build.fingerprintHash === fingerprintHash,
        ) ?? null;
      return {
        code: 0,
        stdout: JSON.stringify({
          platform,
          channel: scope,
          fingerprintHash,
          appVersion: null,
          nativeBuild: storeRow ?? (found && row(found)),
          downloadUrl: found && `https://storage.example.com/${found.id}`,
          ...(args.includes("--store-status")
            ? {
                store: storeRow
                  ? {
                      destination: "play-internal",
                      url: "https://play.google.com/apps/testing/app",
                      version: "1.0 (2)",
                      state: "ready",
                      expiresAtMs: null,
                      reusable: true,
                    }
                  : null,
              }
            : {}),
          ...(appId
            ? {
                sandbox: {
                  appId,
                  otherBuilds:
                    found === null &&
                    onChannel.some(
                      (build) => build.fingerprintHash !== fingerprintHash,
                    ),
                },
              }
            : {}),
        }),
      };
    }
    if (command === "native-build") {
      const scheme = flag("--scheme")!;
      const built = {
        id: `019a0000-0000-7000-8000-00000000c00${++counter}`,
        platform: sub!,
        channel:
          builtChannel ??
          (SANDBOX_SCHEMES[scheme] ? `sandbox-${scheme}` : channel),
        fingerprintHash,
        kind: "apk",
      };
      builds.push(built);
      return {
        code: 0,
        stdout: JSON.stringify({
          build: {
            channel: built.channel,
            fingerprintHash,
            appVersion: null,
          },
          nativeBuild: row(built),
          registration: { skipped: null },
        }),
      };
    }
    if (command === "bundle") {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            id: "019a0000-0000-7000-8000-0000000000f1",
            fingerprint_hash: fingerprintHash,
            target_app_version: null,
          },
        ]),
      };
    }
    return { code: 0, stdout: "" };
  });
  return { cli, calls, builds };
};

/**
 * The Console, as `nativeBuildQr.ts` answers. What the sandbox route's image
 * holds comes from the protocol's own `createPreviewLink`, not the action's.
 */
const consoleFetch = async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const headers = new Headers();
  if (url.pathname.endsWith("/preview-qr")) {
    headers.set(
      "x-hot-updater-preview-link",
      createPreviewLink({
        appId: url.searchParams.get("app")!,
        channel: url.searchParams.get("channel")!,
        fingerprintHash: url.searchParams.get("fingerprint")!,
      }),
    );
  } else {
    headers.set(
      "x-hot-updater-download-url",
      `${url.origin}/api/native-builds/${url.searchParams.get("build")}/download`,
    );
  }
  return new Response(null, { status: 200, headers });
};

const run = async (
  fake: ReturnType<typeof fakeCli>,
  overrides: Record<string, string> = {},
  fetchImpl: unknown = consoleFetch,
) => {
  const outputs: Record<string, string> = {};
  const fetchMock = vi.fn(fetchImpl as typeof fetch);
  const notice = vi.fn();
  const result = (await runAction(
    {
      cli: fake.cli,
      buildLogs: vi.fn(() => []),
      fetch: fetchMock,
      github: null,
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      log: {
        info: vi.fn(),
        notice,
        group: <T>(_: string, body: () => Promise<T>) => body(),
      },
    } as never,
    env(overrides),
    event,
  )) as { body: string };
  return {
    body: result.body,
    outputs,
    notice,
    fetched: fetchMock.mock.calls.map(([url]) => String(url)),
  };
};

const sandboxBuild = (fingerprintHash = FINGERPRINT): Build => ({
  id: BUILD_ID,
  platform: "android",
  channel: "sandbox-sandbox",
  fingerprintHash,
  kind: "apk",
});

const QR = previewQrLink(CONSOLE, {
  appId: APP_ID,
  channel: "pr-12",
  fingerprintHash: FINGERPRINT,
}).replaceAll("&", "&amp;");

describe("the link", () => {
  it.each([
    ["com.example.app"],
    [APP_ID],
    ["com.Example-App.sandbox"],
    ["UPPER.Case_1.2"],
  ])("is what the protocol makes for %s, and what the app accepts", (appId) => {
    const link = previewLink({
      appId,
      channel: "pr-12",
      fingerprintHash: FINGERPRINT,
    });

    expect(link).toBe(
      createPreviewLink({
        appId,
        channel: "pr-12",
        fingerprintHash: FINGERPRINT,
      }),
    );
    expect(parsePreviewLink(link)).toMatchObject({
      channel: "pr-12",
      fingerprintHash: FINGERPRINT,
    });
  });

  it("encodes a channel as the protocol does", () => {
    const channel = "pr 12/tv";
    const parts = { appId: APP_ID, channel, fingerprintHash: FINGERPRINT };

    expect(previewLink(parts)).toBe(createPreviewLink(parts));
    expect(parsePreviewLink(previewLink(parts))?.channel).toBe(channel);
  });
});

describe("no sandbox scheme", () => {
  const normal = {
    INPUT_ANDROID_SCHEME: "releaseApk",
  };
  const normalBuild: Build = {
    ...sandboxBuild(),
    channel: "pr-12",
  };

  it("leaves the comment and the outputs as they were", async () => {
    const fake = fakeCli({ builds: [normalBuild] });

    const { body, outputs, fetched } = await run(fake, normal);

    expect(body).toBe(
      [
        COMMENT_MARKER,
        "### Preview on `pr-12`",
        [
          "| Platform | Native build | Fingerprint | Bundle |",
          "| --- | --- | --- | --- |",
          `| Android | [Download](${CONSOLE}/api/native-builds/${BUILD_ID}/download) · [Details](${CONSOLE}/native-builds/${BUILD_ID}) · reused | \`${FINGERPRINT.slice(0, 12)}\` | \`019a0000-0000-7000-8000-0000000000f1\` |`,
        ].join("\n"),
        "This pull request's native builds embed the `pr-12` channel, so they open its bundle on their first launch.",
        "Scan with an Android phone to download the APK. The phone signs in to the Console first, and for a private Console it has to be on the Console's network.",
        `<img src="${CONSOLE}/_hot-updater/native-builds/qr?build=${BUILD_ID}" alt="QR code of the download of app-release.apk" width="180" height="180">`,
        [
          "<details>",
          "<summary>Install on an emulator or simulator</summary>",
          "",
          "Download the build, then:",
          "",
          "```sh",
          "adb install -r app-release.apk",
          "```",
          "",
          "</details>",
        ].join("\n"),
        "<sub>Deployed `0123456` · Preview by [hot-updater](https://hot-updater.dev)</sub>",
      ].join("\n\n"),
    );
    expect(Object.keys(outputs).sort()).toEqual([
      "android-download-url",
      "android-install-url",
      "comment-body",
      "previews",
    ]);
    expect(JSON.parse(outputs["previews"]!)[0]).not.toHaveProperty("sandbox");
    expect(fetched.some((url) => url.includes("preview-qr"))).toBe(false);
  });

  it("runs the commands it ran, naming the channel only for the download", async () => {
    const fake = fakeCli({ builds: [normalBuild] });

    await run(fake, normal);

    expect(fake.calls).toEqual([
      "channel set pr-12",
      "native-build find -p android -s releaseApk --json",
      "fingerprint create",
      "deploy -p android -c pr-12 -m #12 Fix the header",
      "bundle list -c pr-12 -p android --limit 1 --json",
      "native-build find -p android -c pr-12 -s releaseApk --json",
    ]);
  });

  it("asks for the pull request's channel when the project embeds another", async () => {
    const fake = fakeCli({ builds: [] });

    await expect(
      run(
        {
          ...fake,
          cli: vi.fn(async (args: string[]) =>
            // A config plugin keeps the channel, as an Expo project's can.
            args[0] === "channel" ? { code: 0, stdout: "" } : fake.cli(args),
          ) as never,
        },
        normal,
      ),
    ).rejects.toThrow("embeds the production channel, not pr-12");
    expect(fake.calls.slice(1, 3)).toEqual([
      "native-build find -p android -c pr-12 -s releaseApk --json",
      "native-build android --scheme releaseApk --json",
    ]);
  });

  it("refuses a fallback scheme, which only a sandbox scheme can use", async () => {
    const fake = fakeCli();

    await expect(
      run(fake, { ...normal, INPUT_ANDROID_FALLBACK_SCHEME: "other" }),
    ).rejects.toThrow("android-fallback-scheme goes with a sandbox scheme");
    expect(fake.calls.some((call) => call.startsWith("deploy"))).toBe(false);
  });
});

describe("a sandbox build that has the fingerprint", () => {
  it("reuses it, on the sandbox's channel, and deploys to the pull request's", async () => {
    const fake = fakeCli({ builds: [sandboxBuild()] });

    await run(fake);

    expect(fake.calls).toEqual([
      "channel set pr-12",
      "native-build find -p android -s sandbox --json",
      "fingerprint create",
      "deploy -p android -c pr-12 -m #12 Fix the header",
      "bundle list -c pr-12 -p android --limit 1 --json",
      "native-build find -p android -s sandbox --json",
    ]);
  });

  it("comments the install link and the deep link's QR code", async () => {
    const { body, outputs, fetched } = await run(
      fakeCli({ builds: [sandboxBuild()] }),
    );

    expect(body).toContain(
      `[Download](${CONSOLE}/api/native-builds/${BUILD_ID}/download)`,
    );
    expect(body).toContain("reused");
    expect(body).toContain(`<img src="${QR}"`);
    expect(body).toContain(`\`${LINK}\``);
    expect(outputs["android-sandbox-link"]).toBe(LINK);
    expect(outputs["android-install-url"]).toBe(
      `${CONSOLE}/api/native-builds/${BUILD_ID}/download`,
    );
    expect(outputs["android-download-url"]).toBe(
      `https://storage.example.com/${BUILD_ID}`,
    );
    expect(JSON.parse(outputs["previews"]!)[0].sandbox).toEqual({
      appId: APP_ID,
      link: LINK,
      minBundleId: MIN_BUNDLE_ID,
    });
    expect(parsePreviewLink(outputs["android-sandbox-link"]!)).toEqual({
      urlScheme: "hu-sandbox-com-example-app-tv",
      channel: "pr-12",
      fingerprintHash: FINGERPRINT,
    });
    // The QR code is the link's: never the download's.
    expect(body).not.toContain("_hot-updater/native-builds/qr?");
    expect(fetched.some((url) => url.includes("native-builds/qr?"))).toBe(
      false,
    );
  });

  it("claims nothing of a first launch or a dev server", async () => {
    const { body } = await run(fakeCli({ builds: [sandboxBuild()] }));

    expect(body).not.toMatch(/first launch|dev server|metro/i);
    expect(body).not.toContain("embed the");
  });

  it("says the bundle runs on the build, and to push again for a newer one", async () => {
    const { body } = await run(fakeCli({ builds: [sandboxBuild()] }));

    expect(body).toContain(
      "This pull request's bundle runs on the sandbox build above. A newer sandbox build won't run it: push again.",
    );
    expect(body).not.toContain("is older than");
    expect(body).not.toContain("made a new sandbox build");
  });

  it("says when the build floors out the bundle", async () => {
    const floor = "019a0000-0000-7000-8000-00000000ffff";
    const { body } = await run(
      fakeCli({ builds: [{ ...sandboxBuild(), minBundleId: floor }] }),
    );

    expect(body).toContain(
      `Bundle \`019a0000-0000-7000-8000-0000000000f1\` is older than sandbox build \`${BUILD_ID}\` accepts. Push again.`,
    );
    expect(body).not.toContain("bundle runs on the sandbox build");
  });

  it("keeps the link and drops the image when the Console can't serve it", async () => {
    const down = async () => new Response(null, { status: 404 });
    const { body, notice } = await run(
      fakeCli({ builds: [sandboxBuild()] }),
      {},
      down,
    );

    expect(body).not.toContain("<img");
    expect(body).toContain(`\`${LINK}\``);
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining("No QR code in the comment"),
    );
  });

  it("drops the image when the Console's QR code holds another link", async () => {
    const wrong = async () =>
      new Response(null, {
        headers: { "x-hot-updater-preview-link": "hu-sandbox-other://x" },
      });
    const { body } = await run(
      fakeCli({ builds: [sandboxBuild()] }),
      {},
      wrong,
    );

    expect(body).not.toContain("<img");
  });
});

describe("no sandbox build at all", () => {
  it("builds one and comments its QR code", async () => {
    const fake = fakeCli();

    const { body, outputs } = await run(fake);

    expect(fake.calls).toContain(
      "native-build android --scheme sandbox --json",
    );
    expect(fake.calls.join("\n")).not.toContain(
      "native-build find -p android -c",
    );
    expect(body).toContain("built for this commit");
    expect(body).toContain(`<img src="${QR}"`);
    expect(outputs["android-sandbox-link"]).toBe(LINK);
    expect(body).toContain(
      "This run made a new sandbox build, which other open pull requests' bundles may not run on. Push those pull requests again.",
    );
  });

  it("builds a sandbox build even with a fallback scheme", async () => {
    const fake = fakeCli();

    await run(fake, { INPUT_ANDROID_FALLBACK_SCHEME: "releaseApk" });

    expect(fake.calls).toContain(
      "native-build android --scheme sandbox --json",
    );
    expect(fake.calls.join("\n")).not.toContain("--scheme releaseApk");
  });

  it("fails when the build embeds another channel", async () => {
    const fake = fakeCli({ builtChannel: "production" });

    await expect(run(fake)).rejects.toThrow(
      "embeds the production channel, not sandbox-sandbox",
    );
    expect(fake.calls.some((call) => call.startsWith("deploy"))).toBe(false);
  });
});

describe("a pull request whose fingerprint differs from the sandbox build", () => {
  const fallback = { INPUT_ANDROID_FALLBACK_SCHEME: "releaseApk" };

  it("falls back to a native build on its channel, with no sandbox QR code", async () => {
    const fake = fakeCli({ builds: [sandboxBuild(OLD_FINGERPRINT)] });

    const { body, outputs, fetched } = await run(fake, fallback);

    expect(fake.calls).toEqual([
      "channel set pr-12",
      "native-build find -p android -s sandbox --json",
      "native-build find -p android -c pr-12 -s releaseApk --json",
      "native-build android --scheme releaseApk --json",
      "deploy -p android -c pr-12 -m #12 Fix the header",
      "bundle list -c pr-12 -p android --limit 1 --json",
      "native-build find -p android -c pr-12 -s releaseApk --json",
    ]);
    expect(body).not.toContain("hu-sandbox-");
    expect(body).not.toContain("preview-qr");
    expect(fetched.some((url) => url.includes("preview-qr"))).toBe(false);
    expect(outputs).not.toHaveProperty("android-sandbox-link");
    // The existing flow, with its download QR code and its channel.
    expect(body).toContain("_hot-updater/native-builds/qr?build=");
    expect(body).toContain(
      "This pull request's native builds embed the `pr-12` channel",
    );
    expect(body).toContain(
      "Android: this pull request's native code differs from the sandbox builds', so it has its own native build and no sandbox QR code.",
    );
    const [preview] = JSON.parse(outputs["previews"]!);
    expect(preview.fallbackScheme).toBe("releaseApk");
    expect(preview).not.toHaveProperty("sandbox");
    expect(outputs["android-download-url"]).toContain("storage.example.com");
  });

  it("reuses the fallback's build on a later push", async () => {
    const fake = fakeCli({
      builds: [
        sandboxBuild(OLD_FINGERPRINT),
        { ...sandboxBuild(), id: "fallback-build", channel: "pr-12" },
      ],
    });

    const { body } = await run(fake, fallback);

    expect(fake.calls.join("\n")).not.toContain("--scheme releaseApk");
    expect(body).toContain("fallback-build");
    expect(body).not.toContain("hu-sandbox-");
  });

  it("doesn't fall back while a sandbox build has this fingerprint", async () => {
    const fake = fakeCli({
      builds: [sandboxBuild(OLD_FINGERPRINT), sandboxBuild()],
    });

    const { body } = await run(fake, fallback);

    expect(fake.calls.join("\n")).not.toContain("releaseApk");
    expect(body).toContain(`\`${LINK}\``);
  });

  it("builds a new sandbox build when no scheme can embed the channel", async () => {
    const fake = fakeCli({ builds: [sandboxBuild(OLD_FINGERPRINT)] });

    const { body, outputs } = await run(fake);

    expect(fake.calls).toContain(
      "native-build android --scheme sandbox --json",
    );
    expect(outputs["android-sandbox-link"]).toBe(LINK);
    expect(body).toContain("A sandbox build with other native code refuses");
    expect(body).toContain("This run made a new sandbox build");
  });
});

describe("a store build", () => {
  const storeInputs = { INPUT_ANDROID_SUBMIT: "play-internal" };
  const submitted = {
    id: BUILD_ID,
    artifact_kind: "aab",
    artifact_storage_uri: "s3://bucket/native-builds/android/x/app.aab",
    submitted_to: "play-internal",
    min_bundle_id: MIN_BUNDLE_ID,
  };

  it("runs the store's commands, and adds only the QR code", async () => {
    const fake = fakeCli({ storeRow: submitted });

    const { body, outputs } = await run(fake, storeInputs);

    expect(fake.calls).toEqual([
      "channel set pr-12",
      "native-build find -p android -s sandbox --store-status --json",
      "fingerprint create",
      "deploy -p android -c pr-12 -m #12 Fix the header",
      "bundle list -c pr-12 -p android --limit 1 --json",
      "native-build find -p android -s sandbox --json",
    ]);
    expect(body).toContain("Testers install the sandbox build from");
    expect(body).toContain("[Google Play internal testing](");
    expect(body).not.toContain("api/native-builds");
    expect(body).toContain(`<img src="${QR}"`);
    expect(outputs["android-sandbox-link"]).toBe(LINK);
  });

  it("refuses a fallback scheme beside a store input", () => {
    expect(() =>
      parseInputs(
        env({ ...storeInputs, INPUT_ANDROID_FALLBACK_SCHEME: "releaseApk" }),
        event,
      ),
    ).toThrow("android-fallback-scheme doesn't go with android-submit");
  });
});

describe("a project with no fingerprint", () => {
  it("has no link to show, since a link names a fingerprint", async () => {
    const fake = fakeCli({ builds: [] });
    const cli = vi.fn(async (args: string[]) => {
      const result = await fake.cli(args);
      if (args[0] !== "native-build") return result;
      const json = JSON.parse(result.stdout);
      if (args[1] === "find") {
        return {
          ...result,
          stdout: JSON.stringify({
            ...json,
            fingerprintHash: null,
            appVersion: "1.0.0",
          }),
        };
      }
      return {
        ...result,
        stdout: JSON.stringify({
          ...json,
          build: { ...json.build, fingerprintHash: null, appVersion: "1.0.0" },
        }),
      };
    });
    const bundles = vi.fn(async (args: string[]) =>
      args[0] === "bundle"
        ? {
            code: 0,
            stdout: JSON.stringify([
              {
                id: "bundle-1",
                fingerprint_hash: null,
                target_app_version: "1.0.0",
              },
            ]),
          }
        : cli(args),
    );

    const { body, outputs, fetched } = await run({
      ...fake,
      cli: bundles as never,
    });

    expect(body).not.toContain("hu-sandbox-");
    expect(outputs["android-sandbox-link"]).toBe("");
    expect(fetched.some((url) => url.includes("preview-qr"))).toBe(false);
    expect(body).toContain("A newer sandbox build won't run it");
  });
});

describe("a sandbox scheme beside a normal one", () => {
  it("gives each platform its own flow", async () => {
    const fake = fakeCli({
      builds: [
        sandboxBuild(),
        {
          ...sandboxBuild(),
          platform: "ios",
          channel: "pr-12",
          kind: "app",
          id: "ios-build",
        },
      ],
    });

    const { body, outputs } = await run(fake, {
      INPUT_PLATFORMS: "android,ios",
      INPUT_IOS_SCHEME: "simulator",
    });

    expect(outputs["android-sandbox-link"]).toBe(LINK);
    expect(outputs).not.toHaveProperty("ios-sandbox-link");
    expect(body).toContain(`\`${LINK}\``);
    // The iOS build embeds the channel, and the sentence is about it.
    expect(body).toContain("native builds embed the `pr-12` channel");
    expect(fake.calls).toContain(
      "native-build find -p ios -c pr-12 -s simulator --json",
    );
  });
});
