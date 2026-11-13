import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createPreviewLink,
  parsePreviewLink,
  sandboxUrlSchemeOf,
} from "../../../packages/protocol/src/nativeArtifact/sandbox";
import { COMMENT_MARKER, previewLink } from "./comment.mjs";
import { runAction } from "./preview.mjs";
import { fakeGitHub } from "./testing/fakeGitHub";

const CONSOLE = "https://console.example.com";
const FINGERPRINT = "a".repeat(64);
const OLD_FINGERPRINT = "b".repeat(64);
const APP_ID = "com.Example.App_tv";
const LINK = `hu-sandbox-com-example-app-tv://hot-updater/preview?channel=pr-12&fingerprint=${FINGERPRINT}&platform=android`;
const IOS_LINK = `hu-sandbox-com-example-app-tv://hot-updater/preview?channel=pr-12&fingerprint=${FINGERPRINT}&platform=ios`;
const BUILD_ID = "019a0000-0000-7000-8000-00000000b001";
const MIN_BUNDLE_ID = "019a0000-0000-7000-8000-000000000010";
const LATEST_COMMIT =
  "<sub>Latest commit: [`0123456`](https://github.com/octo/app/commit/0123456789abcdef)</sub>";

const event = {
  action: "synchronize",
  number: 12,
  title: "Fix the header",
  commitSha: "0123456789abcdef",
  repositoryUrl: "https://github.com/octo/app",
  runUrl: "https://github.com/octo/app/actions/runs/42",
  fromFork: false,
};

const env = (overrides: Record<string, string> = {}) => ({
  INPUT_CONSOLE_URL: CONSOLE,
  INPUT_PLATFORMS: "android",
  INPUT_ANDROID_SCHEME: "sandbox",
  INPUT_COMMENT: "true",
  ...overrides,
});

type Build = {
  id: string;
  platform: string;
  channel: string;
  fingerprintHash: string;
  kind: string;
  minBundleId?: string;
  /** Whether it is a sandbox build, which `find` finds on any channel. */
  sandbox?: boolean;
  /** The URL scheme a sandbox build registered. */
  sandboxUrlScheme?: string;
};

const SANDBOX_SCHEMES: Readonly<Record<string, string>> = { sandbox: APP_ID };

const row = (build: Build) => ({
  id: build.id,
  artifact_kind: build.kind,
  artifact_storage_uri: `s3://bucket/native-builds/${build.platform}/${build.id}/app-release.apk`,
  min_bundle_id: build.minBundleId ?? MIN_BUNDLE_ID,
  sandbox_url_scheme: build.sandboxUrlScheme ?? null,
});

/**
 * The project's CLI as the real one answers: every scheme embeds what
 * `channel set` wrote, and `find` looks for a sandbox scheme's build on any
 * channel, by the URL scheme `urlScheme` (the config's) or the derived one.
 * Only a sandbox scheme's result has `sandbox`, which names the channel the
 * found build embeds.
 */
const fakeCli = ({
  fingerprintHash = FINGERPRINT,
  builds = [] as Build[],
  urlScheme = undefined as string | undefined,
  builtChannel = undefined as string | undefined,
  reportedChannel = undefined as string | undefined,
  storeRow = undefined as Record<string, unknown> | undefined,
  iosDevices = undefined as Record<string, unknown> | undefined,
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
      const scope = asked ?? channel;
      const linkScheme = urlScheme ?? (appId && sandboxUrlSchemeOf(appId));
      // A sandbox scheme's lookup names no channel: its builds are found on
      // any, by the URL scheme they register.
      const found =
        builds.findLast((build) =>
          appId
            ? build.platform === platform &&
              build.sandbox === true &&
              build.sandboxUrlScheme === linkScheme &&
              build.fingerprintHash === fingerprintHash
            : build.platform === platform &&
              build.sandbox !== true &&
              build.channel === scope &&
              build.fingerprintHash === fingerprintHash,
        ) ?? null;
      return {
        code: 0,
        stdout: JSON.stringify({
          platform,
          channel: reportedChannel ?? scope,
          fingerprintHash,
          appVersion: null,
          nativeBuild: storeRow ?? (found && row(found)),
          downloadUrl: found && `https://storage.example.com/${found.id}`,
          ...(found && iosDevices ? { iosDevices } : {}),
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
                  urlScheme: linkScheme,
                  channel: found?.channel ?? null,
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
        channel: builtChannel ?? channel,
        fingerprintHash,
        kind: "apk",
        ...(SANDBOX_SCHEMES[scheme]
          ? {
              sandbox: true,
              sandboxUrlScheme:
                urlScheme ?? sandboxUrlSchemeOf(SANDBOX_SCHEMES[scheme]!),
            }
          : {}),
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

/** Where the action writes the QR code that holds `value`. */
const qrPath = (value: string) =>
  `pr-12/${createHash("sha256").update(value).digest("hex").slice(0, 16)}.png`;

/** The comment's image of the QR code that holds `value`. */
const qrImage = (value: string) =>
  `https://github.com/octo/app/raw/hot-updater-preview/${qrPath(value)}`;

const run = async (
  fake: ReturnType<typeof fakeCli>,
  overrides: Record<string, string> = {},
) => {
  const outputs: Record<string, string> = {};
  const github = fakeGitHub();
  const notice = vi.fn();
  const result = (await runAction(
    {
      cli: fake.cli,
      buildLogs: vi.fn(() => []),
      github: github.github,
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      log: {
        info: vi.fn(),
        notice,
        error: vi.fn(),
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
    /** The paths of the QR code branch, without its README. */
    written: Object.keys(github.files() ?? {}).filter(
      (path) => path !== "README.md",
    ),
  };
};

/** A sandbox build another pull request made, which this one can reuse. */
const sandboxBuild = (fingerprintHash = FINGERPRINT): Build => ({
  id: BUILD_ID,
  platform: "android",
  channel: "pr-10",
  fingerprintHash,
  kind: "apk",
  sandbox: true,
  sandboxUrlScheme: sandboxUrlSchemeOf(APP_ID),
});

const QR = qrImage(LINK);
const DOWNLOAD = `${CONSOLE}/api/native-builds/${BUILD_ID}/download`;

describe("the link", () => {
  it.each([
    ["com.example.app"],
    [APP_ID],
    ["com.Example-App.sandbox"],
    ["UPPER.Case_1.2"],
  ])("is what the protocol makes for %s, and what the app accepts", (appId) => {
    const link = previewLink({
      urlScheme: sandboxUrlSchemeOf(appId),
      channel: "pr-12",
      fingerprintHash: FINGERPRINT,
      platform: "android",
    });

    expect(link).toBe(
      createPreviewLink({
        appId,
        channel: "pr-12",
        fingerprintHash: FINGERPRINT,
        platform: "android",
      }),
    );
    expect(parsePreviewLink(link)).toMatchObject({
      channel: "pr-12",
      fingerprintHash: FINGERPRINT,
    });
  });

  it.each(["ios", "android"] as const)(
    "encodes a channel and names %s as the protocol does",
    (platform) => {
      const channel = "pr 12/tv";
      const parts = {
        urlScheme: "acme.preview+qa",
        channel,
        fingerprintHash: FINGERPRINT,
        platform,
      };

      expect(previewLink(parts)).toBe(createPreviewLink(parts));
      expect(parsePreviewLink(previewLink(parts))).toEqual({
        urlScheme: "acme.preview+qa",
        channel,
        fingerprintHash: FINGERPRINT,
        platform,
      });
    },
  );
});

describe("no sandbox scheme", () => {
  const normal = {
    INPUT_ANDROID_SCHEME: "releaseApk",
  };
  const normalBuild: Build = {
    ...sandboxBuild(),
    channel: "pr-12",
    sandbox: false,
  };

  it("leaves the comment and the outputs as they were", async () => {
    const fake = fakeCli({ builds: [normalBuild] });

    const { body, outputs, written } = await run(fake, normal);

    expect(body).toBe(
      [
        COMMENT_MARKER,
        "### Preview on `pr-12`",
        "**Install this pull request's build.** It opens the latest bundle on `pr-12` on its first launch.",
        `- **Android**: [Download APK](${DOWNLOAD}) · [Details](${CONSOLE}/native-builds/${BUILD_ID}) · allow "Install unknown apps" when Android asks`,
        LATEST_COMMIT,
        [
          "<details>",
          "<summary>Builds</summary>",
          "",
          "| Platform | Native build | Fingerprint | Bundle |",
          "| --- | --- | --- | --- |",
          `| Android | \`${BUILD_ID}\` · reused | \`${FINGERPRINT.slice(0, 12)}\` | \`019a0000-0000-7000-8000-0000000000f1\` |`,
          "",
          "</details>",
        ].join("\n"),
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
        "<sub>Preview by [hot-updater](https://hot-updater.dev)</sub>",
      ].join("\n\n"),
    );
    expect(Object.keys(outputs).sort()).toEqual([
      "android-download-url",
      "android-install-url",
      "comment-body",
      "previews",
    ]);
    expect(JSON.parse(outputs["previews"]!)[0]).not.toHaveProperty("sandbox");
    expect(written).toEqual([]);
  });

  it("runs the commands it ran, naming the channel only for the download", async () => {
    const fake = fakeCli({ builds: [normalBuild] });

    await run(fake, normal);

    expect(fake.calls).toEqual([
      "channel set pr-12",
      "native-build find -p android -s releaseApk --json",
      "fingerprint create",
      "deploy -p android -c pr-12 -m 0123456 · #12 Fix the header",
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
});

describe("a sandbox build that has the fingerprint", () => {
  it("reuses another pull request's build, and deploys to this one's channel", async () => {
    const fake = fakeCli({ builds: [sandboxBuild()] });

    const { body } = await run(fake);

    expect(fake.calls).toEqual([
      "channel set pr-12",
      "native-build find -p android -s sandbox --json",
      "fingerprint create",
      "deploy -p android -c pr-12 -m 0123456 · #12 Fix the header",
      "bundle list -c pr-12 -p android --limit 1 --json",
      "native-build find -p android -c pr-12 -s sandbox --json",
    ]);
    expect(body).toContain(
      "Sandbox build from `pr-10`, with the same native code. Already installed? Skip to step 2.",
    );
  });

  it("says nothing of where a build on this pull request's channel came from", async () => {
    const { body } = await run(
      fakeCli({ builds: [{ ...sandboxBuild(), channel: "pr-12" }] }),
    );

    expect(body).not.toContain("Sandbox build from");
  });

  it("tells the sandbox scheme by what find says of it, not by the channel", async () => {
    const fake = fakeCli({
      builds: [sandboxBuild()],
      reportedChannel: "renamed",
    });

    const { outputs } = await run(fake);

    expect(outputs["android-sandbox-link"]).toBe(LINK);
  });

  it("comments the install link and the deep link's QR code", async () => {
    const { body, outputs, written } = await run(
      fakeCli({ builds: [sandboxBuild()] }),
    );

    expect(body).toContain(
      `**1. Install the sandbox app** once. Pull requests with the same native code share it.\n\n- **Android**: [Download APK](${DOWNLOAD}) · [Details](${CONSOLE}/native-builds/${BUILD_ID}) · allow "Install unknown apps" when Android asks`,
    );
    expect(body).toContain(
      `**2. Scan to open the latest bundle on \`pr-12\`** with the sandbox app.\n${LATEST_COMMIT}\n\n**Android**\n\n<img src="${QR}" alt="QR code of the sandbox link of pr-12" width="180" height="180">\n\n\`${LINK}\``,
    );
    expect(body).toContain(`| Android | \`${BUILD_ID}\` · reused |`);
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
      urlScheme: "hu-sandbox-com-example-app-tv",
      link: LINK,
      minBundleId: MIN_BUNDLE_ID,
      fromChannel: "pr-10",
    });
    expect(parsePreviewLink(outputs["android-sandbox-link"]!)).toEqual({
      urlScheme: "hu-sandbox-com-example-app-tv",
      channel: "pr-12",
      fingerprintHash: FINGERPRINT,
      platform: "android",
    });
    // The QR code is the link's: never the download's.
    expect(written).toEqual([qrPath(LINK)]);
  });

  it("claims nothing of a first launch or a dev server", async () => {
    const { body } = await run(fakeCli({ builds: [sandboxBuild()] }));

    expect(body).not.toMatch(/first launch|dev server|metro/i);
    expect(body).not.toContain("embed the");
  });

  it("adds no notice when the reused build runs the bundle", async () => {
    const { body } = await run(fakeCli({ builds: [sandboxBuild()] }));

    expect(body).not.toContain("is older than");
    expect(body).not.toContain("made a new sandbox build");
    expect(body).not.toContain("runs on the sandbox build");
  });

  it("says when the build floors out the bundle", async () => {
    const floor = "019a0000-0000-7000-8000-00000000ffff";
    const { body } = await run(
      fakeCli({ builds: [{ ...sandboxBuild(), minBundleId: floor }] }),
    );

    expect(body).toContain(
      "Bundle `019a0000-0000-7000-8000-0000000000f1` is older than the sandbox build accepts: push again.",
    );
  });

  it("keeps the link and says to open it, with no image, without its comment", async () => {
    const { body, written } = await run(fakeCli({ builds: [sandboxBuild()] }), {
      INPUT_COMMENT: "false",
    });

    expect(written).toEqual([]);
    expect(body).not.toContain("<img");
    expect(body).not.toContain("Scan");
    expect(body).toContain(
      `**2. Open the latest bundle on \`pr-12\`**: open the link on the phone with the sandbox app.\n${LATEST_COMMIT}\n\n**Android**\n\n\`${LINK}\``,
    );
  });
});

describe("a token that can't write the QR code", () => {
  it("comments the links, then fails with the permission the QR code needs", async () => {
    const github = fakeGitHub({ refuse: true });
    const outputs: Record<string, string> = {};

    await expect(
      runAction(
        {
          cli: fakeCli({ builds: [sandboxBuild()] }).cli,
          buildLogs: vi.fn(() => []),
          github: github.github,
          setOutput: (name: string, value: string) => {
            outputs[name] = value;
          },
          log: {
            info: vi.fn(),
            notice: vi.fn(),
            group: <T>(_: string, body: () => Promise<T>) => body(),
          },
        } as never,
        env(),
        event,
      ),
    ).rejects.toThrow(
      'GitHub answered 403 to POST https://api.github.com/repos/octo/app/git/blobs: give the workflow "permissions: contents: write", and let it create the hot-updater-preview branch.',
    );
    const body = outputs["comment-body"]!;
    expect(github.comment()).toBe(body);
    expect(body).not.toContain("<img");
    expect(body).not.toContain("Scan");
    expect(body).toContain(`\`${LINK}\``);
    expect(outputs["android-sandbox-link"]).toBe(LINK);
  });
});

describe("a sandbox .ipa with no store input", () => {
  const ipa = { ...sandboxBuild(), platform: "ios", kind: "ipa" };
  const inputs = { INPUT_PLATFORMS: "ios", INPUT_IOS_SCHEME: "sandbox" };

  it("shows the deep link's QR code, and keeps its page behind Details", async () => {
    const { body, outputs, written } = await run(
      fakeCli({ builds: [ipa] }),
      inputs,
    );

    expect(body).toContain(`<img src="${qrImage(IOS_LINK)}"`);
    expect(body).toContain(
      `- **iOS**: [Install on iPhone](${CONSOLE}/native-builds/${BUILD_ID}) · [Download IPA](${DOWNLOAD}) · registered devices only`,
    );
    expect(outputs["ios-sandbox-link"]).toBe(IOS_LINK);
    expect(written).toEqual([qrPath(IOS_LINK)]);
  });

  it("gives the Console page, where an iPhone installs it, as its install URL", async () => {
    const { outputs } = await run(fakeCli({ builds: [ipa] }), inputs);

    expect(outputs["ios-install-url"]).toBe(
      `${CONSOLE}/native-builds/${BUILD_ID}`,
    );
    expect(outputs["ios-download-url"]).toBe(
      `https://storage.example.com/${BUILD_ID}`,
    );
  });

  it("links a normal .ipa's install page, with no QR code", async () => {
    const normal = { ...ipa, channel: "pr-12", sandbox: false };

    const { body } = await run(fakeCli({ builds: [normal] }), {
      ...inputs,
      INPUT_IOS_SCHEME: "device",
    });

    expect(body).toContain(
      `- **iOS**: [Install on iPhone](${CONSOLE}/native-builds/${BUILD_ID}) · `,
    );
    expect(body).not.toContain("<img");
    expect(body).not.toContain("hu-sandbox-");
  });
});

describe("no sandbox build at all", () => {
  it("builds one and comments its QR code", async () => {
    const fake = fakeCli();

    const { body, outputs } = await run(fake);

    expect(fake.calls).toContain(
      "native-build android --scheme sandbox --json",
    );
    expect(body).toContain("built for this commit");
    expect(body).toContain(`<img src="${QR}"`);
    expect(outputs["android-sandbox-link"]).toBe(LINK);
    expect(body).toContain(
      "This run made a new sandbox build: push the other open pull requests again.",
    );
  });

  it("builds on the pull request's channel", async () => {
    const fake = fakeCli();

    await run(fake);

    expect(fake.builds).toMatchObject([{ channel: "pr-12", sandbox: true }]);
  });

  it("fails when the build embeds another channel", async () => {
    const fake = fakeCli({ builtChannel: "production" });

    await expect(run(fake)).rejects.toThrow(
      "embeds the production channel, not pr-12",
    );
    expect(fake.calls.some((call) => call.startsWith("deploy"))).toBe(false);
  });
});

describe("the URL scheme a sandbox scheme sets", () => {
  const custom = `acme-preview://hot-updater/preview?channel=pr-12&fingerprint=${FINGERPRINT}&platform=android`;

  it("opens the build it makes with the configured scheme", async () => {
    const { body, outputs } = await run(fakeCli({ urlScheme: "acme-preview" }));

    expect(outputs["android-sandbox-link"]).toBe(custom);
    expect(body).toContain(`\`${custom}\``);
    expect(body).toContain(`<img src="${qrImage(custom)}"`);
    expect(JSON.parse(outputs["previews"]!)[0].sandbox).toMatchObject({
      urlScheme: "acme-preview",
      link: custom,
    });
  });

  it("reuses only a build of the configured scheme", async () => {
    const fake = fakeCli({
      urlScheme: "acme-preview",
      builds: [{ ...sandboxBuild(), sandboxUrlScheme: "acme-next" }],
    });

    const { outputs } = await run(fake);

    expect(fake.calls).toContain(
      "native-build android --scheme sandbox --json",
    );
    expect(outputs["android-sandbox-link"]).toBe(custom);
  });
});

describe("a pull request whose fingerprint differs from the sandbox builds", () => {
  it("builds a new sandbox build on its channel, and says to push the others", async () => {
    const fake = fakeCli({ builds: [sandboxBuild(OLD_FINGERPRINT)] });

    const { body, outputs } = await run(fake);

    expect(fake.calls).toContain(
      "native-build android --scheme sandbox --json",
    );
    expect(fake.builds.at(-1)).toMatchObject({
      channel: "pr-12",
      fingerprintHash: FINGERPRINT,
    });
    expect(outputs["android-sandbox-link"]).toBe(LINK);
    expect(body).toContain("**2. Scan to open the latest bundle on `pr-12`**");
    expect(body).toContain("This run made a new sandbox build");
  });
});

describe("an ad hoc .ipa that lacks an approved device", () => {
  const ipa = { ...sandboxBuild(), platform: "ios", kind: "ipa" };
  const inputs = { INPUT_PLATFORMS: "ios", INPUT_IOS_SCHEME: "sandbox" };

  it("builds again without the cache, and says to push the other pull requests", async () => {
    const fake = fakeCli({
      builds: [ipa],
      iosDevices: {
        reusable: false,
        reason: "missing",
        missing: ["Ana's iPhone"],
        waiting: [],
      },
    });

    const { body } = await run(fake, inputs);

    expect(fake.calls).toContain(
      "native-build ios --scheme sandbox --no-cache --json",
    );
    expect(body).toContain("built for this commit");
    expect(body).toContain(
      "This run made a new sandbox build: push the other open pull requests again.",
    );
  });

  it("reuses it, and names the devices Apple hasn't taken yet", async () => {
    const fake = fakeCli({
      builds: [ipa],
      iosDevices: {
        reusable: true,
        reason: null,
        missing: [],
        waiting: ["Bo's iPad"],
      },
    });

    const { notice } = await run(fake, inputs);

    expect(fake.calls.some((call) => call.startsWith("native-build ios"))).toBe(
      false,
    );
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("Bo's iPad"));
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
      "deploy -p android -c pr-12 -m 0123456 · #12 Fix the header",
      "bundle list -c pr-12 -p android --limit 1 --json",
      "native-build find -p android -c pr-12 -s sandbox --json",
    ]);
    expect(body).toContain(
      "- **Android**: [Google Play internal testing](https://play.google.com/apps/testing/app) · `1.0 (2)` · ready to install · [Details](",
    );
    expect(body).not.toContain("TestFlight");
    expect(body).not.toContain("api/native-builds");
    expect(body).toContain(`<img src="${QR}"`);
    expect(outputs["android-sandbox-link"]).toBe(LINK);
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

    const { body, outputs, written } = await run({
      ...fake,
      cli: bundles as never,
    });

    expect(body).not.toContain("hu-sandbox-");
    expect(outputs["android-sandbox-link"]).toBe("");
    expect(written).toEqual([]);
    expect(body).not.toContain("Scan");
    // Without a link there's no second step to number.
    expect(body).toContain("**Install the sandbox app** once.");
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
          sandbox: false,
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
    // The iOS build embeds the channel: it needs no scan.
    expect(body).toContain(
      "**This pull request's own build** opens the latest bundle on `pr-12` on its first launch.\n\n- **iOS Simulator**: ",
    );
    expect(fake.calls).toContain(
      "native-build find -p ios -c pr-12 -s simulator --json",
    );
  });
});

describe("a platform that fails", () => {
  const error = vi.fn();
  const deps = (fake: ReturnType<typeof fakeCli>) => {
    const github = fakeGitHub();
    return {
      github,
      deps: {
        cli: fake.cli,
        buildLogs: vi.fn(() => []),
        github: github.github,
        setOutput: vi.fn(),
        log: {
          info: vi.fn(),
          notice: vi.fn(),
          error,
          group: <T>(_: string, body: () => Promise<T>) => body(),
        },
      } as never,
    };
  };
  // The iOS scheme's native build fails; Android's sandbox build deploys.
  const iosFails = () => {
    const fake = fakeCli({ builds: [sandboxBuild()] });
    const cli = fake.cli.getMockImplementation()!;
    fake.cli.mockImplementation(async (args: string[]) =>
      args[0] === "native-build" && args[1] === "ios"
        ? Promise.reject(new Error("xcodebuild failed."))
        : cli(args),
    );
    return fake;
  };

  it("comments the platforms that deployed, says which failed, then fails", async () => {
    const fake = iosFails();
    const { github, deps: value } = deps(fake);

    await expect(
      runAction(
        value,
        env({ INPUT_PLATFORMS: "ios,android", INPUT_IOS_SCHEME: "simulator" }),
        event,
      ),
    ).rejects.toThrow("xcodebuild failed.");

    const [comment] = github.comments;
    expect(comment?.body).toContain(
      "### Preview on `pr-12`\n\n**iOS** failed on this run: [see the logs](https://github.com/octo/app/actions/runs/42).",
    );
    expect(comment?.body).toContain(`\`${LINK}\``);
    expect(comment?.body).toContain(LATEST_COMMIT);
    expect(comment?.body).not.toContain("iOS Simulator");
    // iOS failed first: Android still deployed, and the error showed at once.
    expect(error).toHaveBeenCalledWith("ios: xcodebuild failed.");
    expect(fake.calls).toContain(
      "deploy -p android -c pr-12 -m 0123456 · #12 Fix the header",
    );
  });

  it("leaves the comment when no platform deployed", async () => {
    const fake = iosFails();
    const { github, deps: value } = deps(fake);

    await expect(
      runAction(
        value,
        env({ INPUT_PLATFORMS: "ios", INPUT_IOS_SCHEME: "simulator" }),
        event,
      ),
    ).rejects.toThrow("xcodebuild failed.");

    expect(github.comments).toEqual([]);
  });
});

describe("a deploy the registry can't confirm", () => {
  const OLD_COMMIT = { ...event, commitSha: "fedcba9876543210" };
  const iosBuild = {
    ...sandboxBuild(),
    platform: "ios",
    channel: "pr-12",
    kind: "app",
    id: "ios-build",
    sandbox: false,
  };
  const both = {
    INPUT_PLATFORMS: "android,ios",
    INPUT_IOS_SCHEME: "simulator",
  };
  const runOn = (
    github: ReturnType<typeof fakeGitHub>,
    fake: ReturnType<typeof fakeCli>,
    overrides: Record<string, string>,
    pullRequest: typeof event,
  ) =>
    runAction(
      {
        cli: fake.cli,
        buildLogs: vi.fn(() => []),
        github: github.github,
        setOutput: vi.fn(),
        log: {
          info: vi.fn(),
          notice: vi.fn(),
          error: vi.fn(),
          group: <T>(_: string, body: () => Promise<T>) => body(),
        },
      } as never,
      env(overrides),
      pullRequest,
    );
  // `deploy` succeeds, then reading the bundle back fails on `platforms`.
  const lookupFails = (platforms: string[]) => {
    const fake = fakeCli({ builds: [sandboxBuild(), iosBuild] });
    const cli = fake.cli.getMockImplementation()!;
    fake.cli.mockImplementation(async (args: string[]) => {
      const platform = args[args.indexOf("-p") + 1]!;
      return args[0] === "bundle" && platforms.includes(platform)
        ? Promise.reject(new Error(`bundle list failed on ${platform}.`))
        : cli(args);
    });
    return fake;
  };
  // The comment of an earlier run, which names its commit.
  const commented = async (overrides: Record<string, string>) => {
    const github = fakeGitHub();
    await runOn(
      github,
      fakeCli({ builds: [sandboxBuild(), iosBuild] }),
      overrides,
      OLD_COMMIT,
    );
    expect(github.comments[0]?.body).toContain("fedcba9");
    return github;
  };

  it("names no commit for the one platform it deployed, then fails", async () => {
    const github = await commented({});
    const fake = lookupFails(["android"]);

    await expect(runOn(github, fake, {}, event)).rejects.toThrow(
      "bundle list failed on android.",
    );

    expect(fake.calls).toContain(
      "deploy -p android -c pr-12 -m 0123456 · #12 Fix the header",
    );
    const body = github.comments[0]!.body;
    expect(body).toBe(
      [
        COMMENT_MARKER,
        "### Preview on `pr-12`",
        "**Android** failed on this run, after deploying its bundle: [see the logs](https://github.com/octo/app/actions/runs/42).",
        "<sub>Preview by [hot-updater](https://hot-updater.dev)</sub>",
      ].join("\n\n"),
    );
  });

  it("names no commit for either platform when both deployed, then fails", async () => {
    const github = await commented(both);
    const fake = lookupFails(["android", "ios"]);

    await expect(runOn(github, fake, both, event)).rejects.toThrow(
      "android: bundle list failed on android.\nios: bundle list failed on ios.",
    );

    const body = github.comments[0]!.body;
    expect(body).toContain(
      "**Android** failed on this run, after deploying its bundle: [see the logs](https://github.com/octo/app/actions/runs/42).\n\n**iOS** failed on this run, after deploying its bundle: [see the logs](https://github.com/octo/app/actions/runs/42).",
    );
    expect(body).not.toContain("fedcba9");
    expect(body).not.toContain("Latest commit");
    expect(body).not.toContain(LINK);
  });

  it("keeps the other platform's commit when only one lookup failed", async () => {
    const github = await commented(both);

    await expect(
      runOn(github, lookupFails(["ios"]), both, event),
    ).rejects.toThrow("bundle list failed on ios.");

    const body = github.comments[0]!.body;
    expect(body).toContain(
      "**iOS** failed on this run, after deploying its bundle",
    );
    expect(body).toContain(LATEST_COMMIT);
    expect(body).not.toContain("fedcba9");
    expect(body).not.toContain("iOS Simulator");
  });
});
