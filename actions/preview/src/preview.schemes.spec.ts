import { describe, expect, it, vi } from "vitest";

import { COMMENT_MARKER } from "./comment.mjs";
import { runAction } from "./preview.mjs";
import { fakeGitHub } from "./testing/fakeGitHub";

const FINGERPRINT = "a".repeat(64);
const OTHER_FINGERPRINT = "b".repeat(64);
const APP_ID = "com.example.app";
const URL_SCHEME = "acme-preview";
const IOS_LINK = `${URL_SCHEME}://hot-updater/preview?channel=pr-12&fingerprint=${FINGERPRINT}&platform=ios`;

const event = {
  action: "synchronize",
  number: 12,
  title: "Fix the header",
  commitSha: "0123456789abcdef",
  repositoryUrl: "https://github.com/octo/app",
  runUrl: "https://github.com/octo/app/actions/runs/42",
  fromFork: false,
};

const env = (iosScheme: string) => ({
  INPUT_CONSOLE_URL: "https://console.example.com",
  INPUT_PLATFORMS: "ios",
  INPUT_IOS_SCHEME: iosScheme,
  INPUT_COMMENT: "true",
});

/** What a `nativeBuild.ios` scheme builds. */
type Scheme = {
  readonly kind: "ipa" | "app";
  /** A sandbox scheme's build is found on any channel. */
  readonly sandbox?: boolean;
  readonly fingerprintHash?: string;
};

const SCHEMES: Readonly<Record<string, Scheme>> = {
  adhoc: { kind: "ipa" },
  simulator: { kind: "app" },
  sandbox: { kind: "ipa", sandbox: true },
  sandboxSimulator: { kind: "app", sandbox: true },
  otherSimulator: {
    kind: "app",
    sandbox: true,
    fingerprintHash: OTHER_FINGERPRINT,
  },
};

type Build = {
  readonly id: string;
  readonly channel: string;
  readonly kind: "ipa" | "app";
  readonly sandbox: boolean;
  readonly fingerprintHash: string;
  readonly minBundleId: string;
};

/** IDs that sort in the order the run makes them, as UUIDv7s do. */
const idOf = (n: number) =>
  `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/**
 * The project's CLI over a registry of iOS builds, as the real one answers a
 * scheme: `find` reads the newest build of the scheme's kind, a sandbox
 * scheme's on any channel, and every build or deploy takes the next ID, so a
 * bundle deployed before a build is older than its built-in bundle.
 */
const fakeCli = ({
  builds = [] as Build[],
  failing = [] as string[],
  deployedFingerprint = FINGERPRINT,
} = {}) => {
  const calls: string[] = [];
  const releases: { id: string; channel: string }[] = [];
  let channel = "production";
  let clock = 100;
  const cli = vi.fn(async (args: string[]) => {
    calls.push(args.join(" "));
    const [command, sub] = args;
    const flag = (name: string) =>
      args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    if (command === "channel" && sub === "set") {
      channel = args[2]!;
      return { code: 0, stdout: "" };
    }
    if (command === "fingerprint") return { code: 0, stdout: "" };
    if (command === "native-build" && sub === "find") {
      const scheme = SCHEMES[flag("-s")!]!;
      const scope = flag("-c") ?? channel;
      const fingerprintHash = scheme.fingerprintHash ?? FINGERPRINT;
      const found =
        builds.findLast(
          (build) =>
            build.kind === scheme.kind &&
            build.fingerprintHash === fingerprintHash &&
            (scheme.sandbox
              ? build.sandbox
              : !build.sandbox && build.channel === scope),
        ) ?? null;
      return {
        code: 0,
        stdout: JSON.stringify({
          platform: "ios",
          channel: scope,
          fingerprintHash,
          appVersion: null,
          nativeBuild: found && {
            id: found.id,
            artifact_kind: found.kind,
            artifact_storage_uri: `s3://bucket/native-builds/ios/${found.id}/App.${found.kind === "ipa" ? "ipa" : "app.zip"}`,
            min_bundle_id: found.minBundleId,
            sandbox_url_scheme: found.sandbox ? URL_SCHEME : null,
          },
          downloadUrl: found && `https://storage.example.com/${found.id}`,
          ...(scheme.sandbox
            ? {
                sandbox: {
                  appId: APP_ID,
                  urlScheme: URL_SCHEME,
                  channel: found?.channel ?? null,
                },
              }
            : {}),
        }),
      };
    }
    if (command === "native-build" && sub === "ios") {
      const name = flag("--scheme")!;
      if (failing.includes(name)) return { code: 1, stdout: "" };
      const scheme = SCHEMES[name]!;
      const id = idOf(++clock);
      const build: Build = {
        id,
        channel: flag("--channel")!,
        kind: scheme.kind,
        sandbox: scheme.sandbox ?? false,
        fingerprintHash: scheme.fingerprintHash ?? FINGERPRINT,
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
          nativeBuild: {
            id,
            artifact_kind: build.kind,
            artifact_storage_uri: `s3://bucket/native-builds/ios/${id}/App.${build.kind === "ipa" ? "ipa" : "app.zip"}`,
            min_bundle_id: build.minBundleId,
            sandbox_url_scheme: build.sandbox ? URL_SCHEME : null,
          },
          registration: { skipped: null },
        }),
      };
    }
    if (command === "deploy") {
      releases.push({ id: idOf(++clock), channel: flag("-c")! });
      return { code: 0, stdout: "" };
    }
    if (command === "bundle" && sub === "list") {
      return {
        code: 0,
        stdout: JSON.stringify(
          releases
            .filter((release) => release.channel === flag("-c"))
            .reverse()
            .map(({ id }) => ({
              id,
              fingerprint_hash: deployedFingerprint,
              target_app_version: null,
            })),
        ),
      };
    }
    throw new Error(`unexpected command ${args.join(" ")}`);
  });
  return { cli, calls, builds, releases };
};

const run = async (
  fake: ReturnType<typeof fakeCli>,
  iosScheme: string,
  logs: (since: number) => string[] = () => [],
) => {
  const github = fakeGitHub();
  const outputs: Record<string, string> = {};
  const log = {
    info: vi.fn(),
    notice: vi.fn(),
    error: vi.fn(),
    group: <T>(_: string, body: () => Promise<T>) => body(),
  };
  const result = await runAction(
    {
      cli: fake.cli,
      buildLogs: vi.fn(logs),
      github: github.github,
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      log,
    } as never,
    env(iosScheme),
    event,
  ).then(
    () => null,
    (error: unknown) => error as Error,
  );
  const body = github.comments.at(-1)?.body ?? "";
  return { error: result, outputs, body, github, log };
};

/** A build already in the registry. */
const registered = (
  n: number,
  kind: "ipa" | "app",
  options: { sandbox?: boolean; channel?: string } = {},
): Build => ({
  id: idOf(n),
  channel: options.channel ?? "pr-12",
  kind,
  sandbox: options.sandbox ?? false,
  fingerprintHash: FINGERPRINT,
  minBundleId: idOf(n + 1),
});

describe("several iOS schemes of one native code", () => {
  it("writes these outputs and this comment for an iPhone and a Simulator sandbox build", async () => {
    const fake = fakeCli({
      builds: [registered(1, "ipa", { sandbox: true, channel: "pr-7" })],
    });

    const { error, outputs, body } = await run(
      fake,
      "sandbox, sandboxSimulator",
    );

    expect(error).toBeNull();
    expect(outputs).toMatchInlineSnapshot(`
      {
        "comment-body": "<!-- hot-updater-preview -->

      ### Preview on \`pr-12\`

      **1. Install the sandbox app** once. Pull requests with the same native code share it.

      - **iOS**: [Install on iPhone](https://console.example.com/native-builds/019a0000-0000-7000-8000-000000000001) · [Download IPA](https://console.example.com/api/native-builds/019a0000-0000-7000-8000-000000000001/download) · registered devices only
      - **iOS Simulator**: [Details](https://console.example.com/native-builds/019a0000-0000-7000-8000-000000000101) · the command below installs it and opens \`pr-12\`

      Sandbox build from \`pr-7\`, with the same native code. Already installed on a phone? Skip to step 2.

      This run made a new sandbox build: push the other open pull requests again.

      **2. Scan to open the latest bundle on \`pr-12\`** with the sandbox app.
      <sub>Latest commit: [\`0123456\`](https://github.com/octo/app/commit/0123456789abcdef)</sub>

      **iOS**

      <img src="https://github.com/octo/app/raw/hot-updater-preview/pr-12/712fd3eeb772e309.png" alt="QR code of the sandbox link of pr-12" width="180" height="180">

      \`acme-preview://hot-updater/preview?channel=pr-12&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&platform=ios\`

      <details>
      <summary>Builds</summary>

      | Platform | Native build | Fingerprint | Bundle |
      | --- | --- | --- | --- |
      | iOS | \`019a0000-0000-7000-8000-000000000001\` · reused | \`aaaaaaaaaaaa\` | \`019a0000-0000-7000-8000-000000000103\` |
      | iOS Simulator | \`019a0000-0000-7000-8000-000000000101\` · built for this commit | \`aaaaaaaaaaaa\` | \`019a0000-0000-7000-8000-000000000103\` |

      </details>

      <details>
      <summary>Install on an emulator or simulator</summary>

      In your project, this downloads the build, installs it on the booted Simulator, and opens the latest bundle on \`pr-12\`:

      \`\`\`sh
      npx hot-updater native-build install 019a0000-0000-7000-8000-000000000101 --open pr-12
      \`\`\`

      </details>

      <sub>Preview by [hot-updater](https://hot-updater.dev)</sub>",
        "ios-download-url": "https://storage.example.com/019a0000-0000-7000-8000-000000000001",
        "ios-install-url": "https://console.example.com/native-builds/019a0000-0000-7000-8000-000000000001",
        "ios-sandbox-link": "acme-preview://hot-updater/preview?channel=pr-12&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&platform=ios",
        "previews": "[{"scheme":"sandbox","platform":"ios","target":{"fingerprintHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","appVersion":null},"nativeBuild":{"id":"019a0000-0000-7000-8000-000000000001","artifactKind":"ipa","fileName":"App.ipa"},"built":false,"bundleId":"019a0000-0000-7000-8000-000000000103","installUrl":"https://console.example.com/native-builds/019a0000-0000-7000-8000-000000000001","sandbox":{"appId":"com.example.app","urlScheme":"acme-preview","fromChannel":"pr-7","link":"acme-preview://hot-updater/preview?channel=pr-12&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&platform=ios","minBundleId":"019a0000-0000-7000-8000-000000000002"},"downloadUrl":"https://storage.example.com/019a0000-0000-7000-8000-000000000001"},{"scheme":"sandboxSimulator","platform":"ios","target":{"fingerprintHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","appVersion":null},"nativeBuild":{"id":"019a0000-0000-7000-8000-000000000101","artifactKind":"app","fileName":"App.app.zip"},"built":true,"bundleId":"019a0000-0000-7000-8000-000000000103","installUrl":"npx hot-updater native-build install 019a0000-0000-7000-8000-000000000101 --open pr-12","sandbox":{"appId":"com.example.app","urlScheme":"acme-preview","fromChannel":null,"link":"acme-preview://hot-updater/preview?channel=pr-12&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&platform=ios","minBundleId":"019a0000-0000-7000-8000-000000000102"},"downloadUrl":"https://storage.example.com/019a0000-0000-7000-8000-000000000101"}]",
        "result": "{"channel":"pr-12","commitSha":"0123456789abcdef","previews":[{"platform":"ios","scheme":"sandbox","target":{"fingerprintHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","appVersion":null},"nativeBuild":{"id":"019a0000-0000-7000-8000-000000000001","artifactKind":"ipa","fileName":"App.ipa"},"built":false,"bundleId":"019a0000-0000-7000-8000-000000000103","sandbox":{"appId":"com.example.app","urlScheme":"acme-preview","link":"acme-preview://hot-updater/preview?channel=pr-12&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&platform=ios","minBundleId":"019a0000-0000-7000-8000-000000000002","fromChannel":"pr-7"}},{"platform":"ios","scheme":"sandboxSimulator","target":{"fingerprintHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","appVersion":null},"nativeBuild":{"id":"019a0000-0000-7000-8000-000000000101","artifactKind":"app","fileName":"App.app.zip"},"built":true,"bundleId":"019a0000-0000-7000-8000-000000000103","sandbox":{"appId":"com.example.app","urlScheme":"acme-preview","link":"acme-preview://hot-updater/preview?channel=pr-12&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&platform=ios","minBundleId":"019a0000-0000-7000-8000-000000000102","fromChannel":null}}],"failed":[]}",
      }
    `);
    expect(body).toMatchInlineSnapshot(`
      "<!-- hot-updater-preview -->

      ### Preview on \`pr-12\`

      **1. Install the sandbox app** once. Pull requests with the same native code share it.

      - **iOS**: [Install on iPhone](https://console.example.com/native-builds/019a0000-0000-7000-8000-000000000001) · [Download IPA](https://console.example.com/api/native-builds/019a0000-0000-7000-8000-000000000001/download) · registered devices only
      - **iOS Simulator**: [Details](https://console.example.com/native-builds/019a0000-0000-7000-8000-000000000101) · the command below installs it and opens \`pr-12\`

      Sandbox build from \`pr-7\`, with the same native code. Already installed on a phone? Skip to step 2.

      This run made a new sandbox build: push the other open pull requests again.

      **2. Scan to open the latest bundle on \`pr-12\`** with the sandbox app.
      <sub>Latest commit: [\`0123456\`](https://github.com/octo/app/commit/0123456789abcdef)</sub>

      **iOS**

      <img src="https://github.com/octo/app/raw/hot-updater-preview/pr-12/712fd3eeb772e309.png" alt="QR code of the sandbox link of pr-12" width="180" height="180">

      \`acme-preview://hot-updater/preview?channel=pr-12&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&platform=ios\`

      <details>
      <summary>Builds</summary>

      | Platform | Native build | Fingerprint | Bundle |
      | --- | --- | --- | --- |
      | iOS | \`019a0000-0000-7000-8000-000000000001\` · reused | \`aaaaaaaaaaaa\` | \`019a0000-0000-7000-8000-000000000103\` |
      | iOS Simulator | \`019a0000-0000-7000-8000-000000000101\` · built for this commit | \`aaaaaaaaaaaa\` | \`019a0000-0000-7000-8000-000000000103\` |

      </details>

      <details>
      <summary>Install on an emulator or simulator</summary>

      In your project, this downloads the build, installs it on the booted Simulator, and opens the latest bundle on \`pr-12\`:

      \`\`\`sh
      npx hot-updater native-build install 019a0000-0000-7000-8000-000000000101 --open pr-12
      \`\`\`

      </details>

      <sub>Preview by [hot-updater](https://hot-updater.dev)</sub>"
    `);
  });

  it("finds or builds every scheme, then deploys the platform's one bundle after the last build", async () => {
    const fake = fakeCli({ builds: [registered(1, "ipa")] });

    const { error, outputs, body, github } = await run(
      fake,
      "adhoc, simulator",
    );

    expect(error).toBeNull();
    expect(
      fake.calls.filter((call) => /^(native-build|deploy)/.test(call)),
    ).toEqual([
      "native-build find -p ios -s adhoc --json",
      "native-build find -p ios -s simulator --json",
      "native-build ios --scheme simulator --channel pr-12 --json",
      "deploy -p ios -c pr-12 -m 0123456 · #12 Fix the header",
      "native-build find -p ios -c pr-12 -s adhoc --json",
      "native-build find -p ios -c pr-12 -s simulator --json",
    ]);
    // The bundle is newer than the new build's built-in bundle.
    expect(body).not.toMatch(/older than/);
    const previews = JSON.parse(outputs["previews"]!);
    expect(
      previews.map(
        ({ scheme, nativeBuild, built, bundleId }: Record<string, never>) => ({
          scheme,
          kind: (nativeBuild as { artifactKind: string }).artifactKind,
          built,
          bundleId,
        }),
      ),
    ).toEqual([
      { scheme: "adhoc", kind: "ipa", built: false, bundleId: idOf(103) },
      { scheme: "simulator", kind: "app", built: true, bundleId: idOf(103) },
    ]);
    // The platform's outputs are its first scheme's.
    expect(outputs["ios-install-url"]).toBe(
      `https://console.example.com/native-builds/${idOf(1)}`,
    );
    expect(github.comments).toHaveLength(1);
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("- **iOS**: [Install on iPhone]");
    expect(body).toContain(
      `- **iOS Simulator**: [Details](https://console.example.com/native-builds/${idOf(101)}) · install with the command below`,
    );
    expect(body).toContain(
      `npx hot-updater native-build install ${idOf(101)}\n`,
    );
  });

  it("writes one QR code, a phone's, and opens the pull request from the Simulator's command", async () => {
    const fake = fakeCli({
      builds: [
        registered(1, "ipa", { sandbox: true, channel: "pr-7" }),
        registered(3, "app", { sandbox: true, channel: "pr-7" }),
      ],
    });

    const { error, outputs, body, github } = await run(
      fake,
      "sandbox, sandboxSimulator",
    );

    expect(error).toBeNull();
    expect(
      Object.keys(github.files() ?? {}).filter((path) => path.endsWith(".png")),
    ).toHaveLength(1);
    expect(body.match(/<img /g)).toHaveLength(1);
    expect(body).toContain(`\`${IOS_LINK}\``);
    expect(body).toContain(
      `- **iOS Simulator**: [Details](https://console.example.com/native-builds/${idOf(3)}) · the command below installs it and opens \`pr-12\``,
    );
    expect(body).toContain(
      "Sandbox build from `pr-7`, with the same native code. Already installed on a phone? Skip to step 2.",
    );
    expect(body).toContain(
      "In your project, this downloads the build, installs it on the booted Simulator, and opens the latest bundle on `pr-12`:",
    );
    expect(body).toContain(
      `npx hot-updater native-build install ${idOf(3)} --open pr-12\n`,
    );
    expect(outputs["ios-sandbox-link"]).toBe(IOS_LINK);
  });

  it("keeps a failed scheme from its peer, names it, keeps each one's log, then fails", async () => {
    const fake = fakeCli({ failing: ["simulator", "sandboxSimulator"] });
    let n = 0;

    const { error, outputs, body } = await run(
      fake,
      "adhoc, simulator, sandboxSimulator",
      () => [`.hot-updater/log/build-${++n}.log`],
    );

    expect(error?.message).toContain(
      "ios (simulator): hot-updater native-build ios",
    );
    expect(error?.message).toContain(
      "ios (sandboxSimulator): hot-updater native-build ios",
    );
    expect(outputs["ios-build-log"]).toBe(
      ".hot-updater/log/build-1.log\n.hot-updater/log/build-2.log",
    );
    expect(body).toContain("- **iOS**: [Install on iPhone]");
    expect(body).toContain(
      "**iOS** (`simulator`) failed on this run: [see the logs](https://github.com/octo/app/actions/runs/42).",
    );
    expect(body).toContain(
      "**iOS** (`sandboxSimulator`) failed on this run: [see the logs](https://github.com/octo/app/actions/runs/42).",
    );
  });

  it("deploys nothing for schemes of different native code, and says so", async () => {
    const fake = fakeCli({
      builds: [registered(1, "ipa", { sandbox: true })],
    });

    const { error } = await run(fake, "sandbox, otherSimulator");

    expect(error?.message).toBe(
      `The ios-scheme schemes build different native code: sandbox (fingerprint ${FINGERPRINT}), otherSimulator (fingerprint ${OTHER_FINGERPRINT}). List schemes of one native code.`,
    );
    expect(fake.calls.some((call) => call.startsWith("deploy"))).toBe(false);
  });

  it("fails every scheme of a deploy the registry can't confirm, after deploying", async () => {
    const fake = fakeCli({
      builds: [registered(1, "ipa"), registered(3, "app")],
      deployedFingerprint: OTHER_FINGERPRINT,
    });

    const { error, body } = await run(fake, "adhoc, simulator");

    expect(error?.message).toContain("ios (adhoc): The ios bundle");
    expect(error?.message).toContain("ios (simulator): The ios bundle");
    expect(body).toContain(
      "**iOS** (`adhoc`) failed on this run, after deploying its bundle",
    );
    expect(body).toContain(
      "**iOS** (`simulator`) failed on this run, after deploying its bundle",
    );
  });
});

describe("a lone sandbox Simulator scheme", () => {
  it("installs and opens the pull request with its command, with no QR code a Simulator can't scan", async () => {
    const fake = fakeCli({
      builds: [registered(1, "app", { sandbox: true, channel: "pr-7" })],
    });

    const { error, outputs, body, github } = await run(
      fake,
      "sandboxSimulator",
    );

    expect(error).toBeNull();
    expect(body).not.toContain("<img ");
    expect(body).not.toContain("Scan");
    expect(
      Object.keys(github.files() ?? {}).filter((path) => path.endsWith(".png")),
    ).toEqual([]);
    expect(body).toContain(
      `npx hot-updater native-build install ${idOf(1)} --open pr-12\n`,
    );
    expect(outputs["ios-install-url"]).toBe(
      `npx hot-updater native-build install ${idOf(1)} --open pr-12`,
    );
    expect(outputs["ios-sandbox-link"]).toBe(IOS_LINK);
  });
});
