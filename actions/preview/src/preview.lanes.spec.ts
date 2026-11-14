import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { COMMENT_MARKER, renderPreviewComment } from "./comment.mjs";
import { upsertComment } from "./github.mjs";
import { laneResult, parseInputs, parseLanes, runAction } from "./preview.mjs";
import { fakeGitHub } from "./testing/fakeGitHub";

const CONSOLE = "https://console.example.com";
const FINGERPRINTS = { android: "a".repeat(64), ios: "b".repeat(64) };
const URL_SCHEME = "acme-preview";
const SIGNED = "X-Amz-Signature=SIGNED-SENTINEL";
const SECRET = "SECRET-SENTINEL";
const RUN = "https://github.com/octo/app/actions/runs/42";

const event = {
  action: "synchronize",
  number: 12,
  title: "Fix the header",
  commitSha: "0123456789abcdef",
  headSha: "0123456789abcdef",
  repositoryUrl: "https://github.com/octo/app",
  runUrl: RUN,
  fromFork: false,
};

/** The sandbox schemes of the lanes, each its own artifact kind. */
const SCHEMES = {
  apk: { platform: "android", kind: "apk" },
  adhoc: { platform: "ios", kind: "ipa" },
  simulator: { platform: "ios", kind: "app" },
} as const;
type SchemeName = keyof typeof SCHEMES;

type Build = {
  id: string;
  platform: string;
  kind: string;
  channel: string;
  fingerprintHash: string;
  minBundleId: string;
};

const idOf = (n: number) =>
  `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const link = (platform: "android" | "ios") =>
  `${URL_SCHEME}://hot-updater/preview?channel=pr-12&fingerprint=${FINGERPRINTS[platform]}&platform=${platform}`;

const qrPath = (value: string) =>
  `pr-12/${createHash("sha256").update(value).digest("hex").slice(0, 16)}.png`;

/**
 * One registry and one channel of bundles that every lane's CLI reads, as
 * the lanes' jobs share the project's server: `find` matches a sandbox build
 * of the scheme's kind on any channel, and it prints a signed download URL,
 * a storage URI, and a field that holds a secret, none of which a lane's
 * result may carry.
 */
const fakeServer = ({
  failing = [] as SchemeName[],
  unconfirmed = [] as string[],
} = {}) => {
  const builds: Build[] = [];
  const releases: { id: string; platform: string; channel: string }[] = [];
  const calls: string[] = [];
  let clock = 100;
  const cliOf = () => {
    let channel = "production";
    return vi.fn(async (args: string[]) => {
      calls.push(args.join(" "));
      const [command, sub] = args;
      const flag = (name: string) =>
        args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
      // Each call waits a turn, so concurrent lanes interleave.
      await Promise.resolve();
      if (command === "channel" && sub === "set") {
        channel = args[2]!;
        return { code: 0, stdout: "" };
      }
      if (command === "fingerprint") return { code: 0, stdout: "" };
      if (command === "native-build" && sub === "find") {
        const scheme = SCHEMES[flag("-s") as SchemeName];
        const fingerprintHash =
          FINGERPRINTS[scheme.platform as "android" | "ios"];
        const found =
          builds.findLast(
            (build) =>
              build.kind === scheme.kind &&
              build.fingerprintHash === fingerprintHash,
          ) ?? null;
        return {
          code: 0,
          stdout: JSON.stringify({
            platform: scheme.platform,
            channel: flag("-c") ?? channel,
            fingerprintHash,
            appVersion: null,
            nativeBuild: found && row(found),
            downloadUrl:
              found && `https://storage.example.com/${found.id}?${SIGNED}`,
            sandbox: {
              appId: "com.example.app",
              urlScheme: URL_SCHEME,
              channel: found?.channel ?? null,
            },
            credentials: SECRET,
          }),
        };
      }
      if (command === "native-build") {
        const name = flag("--scheme") as SchemeName;
        if (failing.includes(name)) return { code: 1, stdout: "" };
        const scheme = SCHEMES[name];
        const build: Build = {
          id: idOf(++clock),
          platform: scheme.platform,
          kind: scheme.kind,
          channel: flag("--channel")!,
          fingerprintHash: FINGERPRINTS[scheme.platform],
          minBundleId: idOf(++clock),
        };
        builds.push(build);
        return {
          code: 0,
          stdout: JSON.stringify({
            build: {
              channel: build.channel,
              fingerprintHash: build.fingerprintHash,
              appVersion: null,
            },
            nativeBuild: row(build),
            registration: { skipped: null },
          }),
        };
      }
      if (command === "deploy") {
        releases.push({
          id: idOf(++clock),
          platform: flag("-p")!,
          channel: flag("-c")!,
        });
        return { code: 0, stdout: "" };
      }
      if (command === "bundle" && sub === "list") {
        const platform = flag("-p")!;
        return {
          code: 0,
          stdout: JSON.stringify(
            releases
              .filter(
                (release) =>
                  release.platform === platform &&
                  release.channel === flag("-c"),
              )
              .reverse()
              .map(({ id }) => ({
                id,
                fingerprint_hash: unconfirmed.includes(platform)
                  ? "c".repeat(64)
                  : FINGERPRINTS[platform as "android" | "ios"],
                target_app_version: null,
              })),
          ),
        };
      }
      throw new Error(`unexpected command ${args.join(" ")}`);
    });
  };
  return { cliOf, builds, releases, calls };
};

const row = (build: Build) => ({
  id: build.id,
  artifact_kind: build.kind,
  artifact_storage_uri: `s3://bucket/${SECRET}/${build.id}/${build.kind === "apk" ? "app-release.apk" : build.kind === "ipa" ? "App.ipa" : "App.app.zip"}`,
  min_bundle_id: build.minBundleId,
  sandbox_url_scheme: URL_SCHEME,
  is_sandbox: true,
});

const log = () => ({
  info: vi.fn(),
  notice: vi.fn(),
  error: vi.fn(),
  group: <T>(_: string, body: () => Promise<T>) => body(),
});

type Lane = {
  name: string;
  platform: "android" | "ios";
  scheme: SchemeName;
  deploy: boolean;
};

const LANES: Lane[] = [
  { name: "android", platform: "android", scheme: "apk", deploy: true },
  { name: "ios-adhoc", platform: "ios", scheme: "adhoc", deploy: true },
  {
    name: "ios-simulator",
    platform: "ios",
    scheme: "simulator",
    deploy: false,
  },
];

/**
 * Runs each lane's job at once, as the workflow's lanes run, with
 * `comment: false`, and returns each one's outputs and failure.
 */
const runLanes = (
  server: ReturnType<typeof fakeServer>,
  github: ReturnType<typeof fakeGitHub>,
) =>
  Promise.all(
    LANES.map(async (lane) => {
      const outputs: Record<string, string> = {};
      const error = await runAction(
        {
          cli: server.cliOf(),
          buildLogs: vi.fn(() => []),
          github: github.github,
          setOutput: (name: string, value: string) => {
            outputs[name] = value;
          },
          log: log(),
        } as never,
        {
          INPUT_CONSOLE_URL: CONSOLE,
          INPUT_PLATFORMS: lane.platform,
          [`INPUT_${lane.platform.toUpperCase()}_SCHEME`]: lane.scheme,
          INPUT_COMMENT: "false",
          INPUT_DEPLOY: String(lane.deploy),
        },
        event,
      ).then(
        () => null,
        (error: unknown) => error as Error,
      );
      return { lane, outputs, error };
    }),
  );

/** The `results` input: each lane's name, its job's conclusion, its result. */
const resultsOf = (lanes: Awaited<ReturnType<typeof runLanes>>) =>
  lanes
    .map(
      ({ lane, outputs, error }) =>
        `${lane.name} ${error ? "failure" : "success"} ${outputs["result"] ?? ""}`,
    )
    .join("\n");

const runComment = async (
  github: ReturnType<typeof fakeGitHub>,
  results: string,
) => {
  const outputs: Record<string, string> = {};
  const logs = log();
  const error = await runAction(
    {
      cli: vi.fn(async () => {
        throw new Error("The comment job runs no CLI.");
      }),
      buildLogs: vi.fn(() => []),
      github: github.github,
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      log: logs,
    } as never,
    {
      INPUT_CONSOLE_URL: CONSOLE,
      INPUT_MODE: "comment",
      INPUT_RESULTS: results,
    },
    event,
  ).then(
    () => null,
    (error: unknown) => error as Error,
  );
  return { outputs, error, log: logs };
};

describe("lanes and a comment job", () => {
  it("leave one comment with every link and QR code, from one bundle per platform", async () => {
    const server = fakeServer();
    const github = fakeGitHub();

    const lanes = await runLanes(server, github);
    // No lane writes to GitHub.
    expect(github.calls).toEqual([]);
    expect(lanes.map(({ error }) => error)).toEqual([null, null, null]);

    const { error } = await runComment(github, resultsOf(lanes));

    expect(error).toBeNull();
    expect(server.releases.map(({ platform }) => platform).sort()).toEqual([
      "android",
      "ios",
    ]);
    expect(server.builds).toHaveLength(3);
    const byKind = (kind: string) =>
      server.builds.find((build) => build.kind === kind)!;
    const [android, adhoc, simulator] = [
      byKind("apk"),
      byKind("ipa"),
      byKind("app"),
    ];
    const iosBundle = server.releases.find(
      ({ platform }) => platform === "ios",
    )!.id;
    const body = github.comment()!;
    expect(github.comments).toHaveLength(1);
    expect(body).toContain(
      `- **Android**: [Download APK](${CONSOLE}/api/native-builds/${android.id}/download)`,
    );
    expect(body).toContain(
      `- **iOS**: [Install on iPhone](${CONSOLE}/native-builds/${adhoc.id})`,
    );
    expect(body).toContain(
      `- **iOS Simulator**: [Details](${CONSOLE}/native-builds/${simulator.id})`,
    );
    expect(body).toContain(
      `npx hot-updater native-build install ${simulator.id} --open pr-12`,
    );
    // The Simulator lane deployed nothing: its row shows the iOS bundle.
    expect(body).toContain(
      `| iOS Simulator | \`${simulator.id}\` · built for this commit | \`${FINGERPRINTS.ios.slice(0, 12)}\` | \`${iosBundle}\` |`,
    );
    expect(body.match(/<img /g)).toHaveLength(2);
    expect(Object.keys(github.files()!).sort()).toEqual(
      ["README.md", qrPath(link("android")), qrPath(link("ios"))].sort(),
    );
    expect(body).not.toContain("older than the sandbox build accepts");
    expect(body).not.toContain("failed on this run");
  });

  it("carry no download URL, storage URI, or secret in a lane's result", async () => {
    const server = fakeServer();
    const lanes = await runLanes(server, fakeGitHub());

    for (const { outputs } of lanes) {
      expect(outputs["result"]).toBeDefined();
      expect(outputs["result"]).not.toContain(SIGNED);
      expect(outputs["result"]).not.toContain(SECRET);
      expect(outputs["result"]).not.toContain("s3://");
      expect(outputs["result"]).not.toContain("https://");
    }
    // The lane's own outputs still give the download URL.
    expect(lanes[0]!.outputs["android-download-url"]).toContain(SIGNED);
  });

  it("show a lane whose build failed, which deployed nothing, beside the others", async () => {
    const server = fakeServer({ failing: ["simulator"] });
    const github = fakeGitHub();

    const lanes = await runLanes(server, github);
    const simulator = lanes[2]!;
    expect(simulator.error).not.toBeNull();
    expect(JSON.parse(simulator.outputs["result"]!)).toEqual({
      channel: "pr-12",
      commitSha: event.commitSha,
      previews: [],
      failed: [{ platform: "ios", scheme: "simulator", deployed: false }],
    });

    await runComment(github, resultsOf(lanes));

    const body = github.comment()!;
    expect(body).toContain(
      `**iOS** (\`simulator\`) failed on this run: [see the logs](${RUN}).`,
    );
    expect(body).toContain("- **Android**: [Download APK]");
    expect(body).toContain("- **iOS**: [Install on iPhone]");
    expect(body).not.toContain("**iOS Simulator**");
  });

  it("show a lane that failed after its deploy as having deployed it", async () => {
    const server = fakeServer({ unconfirmed: ["android"] });
    const github = fakeGitHub();

    const lanes = await runLanes(server, github);
    expect(JSON.parse(lanes[0]!.outputs["result"]!).failed).toEqual([
      { platform: "android", scheme: "apk", deployed: true },
    ]);

    await runComment(github, resultsOf(lanes));

    expect(github.comment()).toContain(
      `**Android** (\`apk\`) failed on this run, after deploying its bundle: [see the logs](${RUN}).`,
    );
  });

  it("give a lane with no result one line: skipped, or none for any other reason", async () => {
    const server = fakeServer();
    const github = fakeGitHub();
    const [android] = await runLanes(server, github);

    await runComment(
      github,
      [
        `android success ${android!.outputs["result"]}`,
        "ios-adhoc failure ",
        "ios-simulator skipped",
        "ios-other success {not json",
      ].join("\n"),
    );

    const body = github.comment()!;
    expect(body).toContain(
      `**ios-adhoc** gave no preview result on this run: [see the logs](${RUN}).`,
    );
    expect(body).toContain("**ios-simulator** was skipped on this run.");
    expect(body).toContain(
      `**ios-other** gave no preview result on this run: [see the logs](${RUN}).`,
    );
    expect(body).toContain("- **Android**: [Download APK]");
  });

  it("leave the comment as it was when no lane deployed anything", async () => {
    const github = fakeGitHub();
    await upsertComment(github.github, 12, `${COMMENT_MARKER}\n\nearlier`);
    github.calls.length = 0;

    const { error } = await runComment(
      github,
      "android failure\nios-adhoc cancelled",
    );

    expect(error).toBeNull();
    expect(github.comment()).toBe(`${COMMENT_MARKER}\n\nearlier`);
    expect(github.calls.filter((call) => !call.startsWith("GET"))).toEqual([]);
  });

  it("write nothing once the pull request has a newer head", async () => {
    const server = fakeServer();
    const github = fakeGitHub({ headSha: "fedcba9876543210" });
    const lanes = await runLanes(server, github);

    const { error, log } = await runComment(github, resultsOf(lanes));

    expect(error).toBeNull();
    expect(github.comments).toEqual([]);
    expect(github.files()).toBeNull();
    expect(log.notice).toHaveBeenCalledWith(
      "Not writing the comment: the pull request's head is fedcba9 now, not this run's 0123456.",
    );
  });

  it("keep the QR codes the earlier comment shows when the new comment fails to land", async () => {
    const server = fakeServer();
    const github = fakeGitHub();
    const results = resultsOf(await runLanes(server, github));
    await runComment(github, results);
    const earlier = github.comment()!;

    // The next run's native code has another fingerprint, so other links.
    github.failCommentWrites();
    const { error } = await runComment(
      github,
      results.replaceAll(FINGERPRINTS.android, "d".repeat(64)),
    );

    expect(error).not.toBeNull();
    expect(github.comment()).toBe(earlier);
    const files = Object.keys(github.files()!);
    for (const [, path] of earlier.matchAll(
      /raw\/hot-updater-preview\/(pr-12\/[0-9a-f]+\.png)/g,
    )) {
      expect(files).toContain(path);
    }
  });

  it("skip a pull request from a fork in comment mode too", async () => {
    const github = fakeGitHub();
    const result = await runAction(
      {
        cli: vi.fn(),
        buildLogs: vi.fn(() => []),
        github: github.github,
        setOutput: vi.fn(),
        log: log(),
      } as never,
      { INPUT_MODE: "comment" },
      { ...event, fromFork: true },
    );

    expect(result).toEqual({ skipped: true });
    expect(github.calls).toEqual([]);
  });

  it("parse comment mode without any scheme", () => {
    expect(
      parseInputs(
        {
          INPUT_CONSOLE_URL: CONSOLE,
          INPUT_MODE: "comment",
          INPUT_RESULTS: "android skipped",
        },
        event,
      ),
    ).toMatchObject({ mode: "comment", results: "android skipped" });
  });
});

describe("a lane's result", () => {
  const sandbox = {
    appId: "com.example.app",
    urlScheme: URL_SCHEME,
    link: link("ios"),
    minBundleId: idOf(1),
    fromChannel: "pr-10",
  };
  const previews = {
    direct: {
      platform: "android",
      target: { fingerprintHash: FINGERPRINTS.android, appVersion: null },
      nativeBuild: { id: idOf(2), artifactKind: "apk", fileName: "a.apk" },
      built: true,
      bundleId: idOf(3),
    },
    simulator: {
      platform: "ios",
      target: { fingerprintHash: FINGERPRINTS.ios, appVersion: null },
      nativeBuild: { id: idOf(4), artifactKind: "app", fileName: "A.app.zip" },
      built: false,
      bundleId: idOf(5),
      sandbox,
    },
    appVersion: {
      platform: "android",
      target: { fingerprintHash: null, appVersion: "1.7.0" },
      nativeBuild: { id: idOf(6), artifactKind: "apk", fileName: "a.apk" },
      built: false,
      bundleId: idOf(7),
    },
    store: {
      platform: "ios",
      target: { fingerprintHash: FINGERPRINTS.ios, appVersion: null },
      nativeBuild: { id: idOf(8), artifactKind: "ipa", fileName: "A.ipa" },
      built: false,
      bundleId: idOf(9),
      store: {
        destination: "testflight",
        url: "https://appstoreconnect.apple.com/apps/1/testflight/ios",
        version: "1.7.0 (66)",
        state: "ready",
        expiresAtMs: null,
        reusable: true,
      },
      sandbox: { ...sandbox, link: link("ios"), fromChannel: null },
    },
  } as const;

  it.each(Object.entries(previews))(
    "renders a %s preview the same after the trip through the output",
    (_, preview) => {
      const render = (list: unknown[]) =>
        renderPreviewComment({
          consoleUrl: CONSOLE,
          channel: "pr-12",
          previews: list as never,
          commitSha: event.commitSha,
          credit: true,
        });
      const output = JSON.stringify(
        laneResult({
          channel: "pr-12",
          commitSha: event.commitSha,
          previews: [preview],
          failed: [],
        }),
      );
      const [lane] = parseLanes(`ios success ${output}`);

      expect(render(lane!.result!.previews)).toBe(render([preview]));
    },
  );
});
