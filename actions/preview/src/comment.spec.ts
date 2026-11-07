import { describe, expect, it } from "vitest";

import {
  nativeBuildInstallUrl,
  qrCodeValues,
  renderClosedComment,
  renderPreviewComment,
  shellQuote,
} from "./comment.mjs";

const android = {
  platform: "android",
  target: { fingerprintHash: "8681de8b88a8db15b82606b4", appVersion: null },
  nativeBuild: {
    id: "019a0000-0000-7000-8000-00000000b001",
    artifactKind: "apk",
    fileName: "app-release.apk",
  },
  built: true,
  bundleId: "019a0000-0000-7000-8000-0000000000a1",
} as const;

const ios = {
  platform: "ios",
  target: { fingerprintHash: "ea472e2231256899c3e6fc35", appVersion: null },
  nativeBuild: {
    id: "019a0000-0000-7000-8000-00000000b002",
    artifactKind: "app",
    fileName: "HotUpdaterExample.app.zip",
  },
  built: false,
  bundleId: "019a0000-0000-7000-8000-0000000000a2",
} as const;

const base = {
  consoleUrl: "https://console.example.com/",
  channel: "pr-12",
  headSha: "0123456789abcdef",
  credit: true,
};

const onStore = {
  destination: "testflight",
  url: "https://appstoreconnect.apple.com/apps/6764/testflight/ios",
  version: "1.7.0 (66)",
  state: "processing",
  expiresAtMs: null,
  reusable: true,
} as const;

const ipaOnTestFlight = {
  ...ios,
  nativeBuild: {
    id: "019a0000-0000-7000-8000-00000000b003",
    artifactKind: "ipa",
    fileName: "App.ipa",
  },
  store: onStore,
} as const;

const aabOnPlay = {
  ...android,
  nativeBuild: {
    id: "019a0000-0000-7000-8000-00000000b004",
    artifactKind: "aab",
    fileName: "app-release.aab",
  },
  store: {
    ...onStore,
    destination: "play-internal",
    url: "https://play.google.com/apps/testing/com.example.app.sandbox",
    version: "1.7.0 (42)",
    state: "draft",
  },
} as const;

const C = "https://console.example.com";
const ANDROID_LINK =
  "hu-sandbox-com-example-app://hot-updater/preview?channel=pr-12&fingerprint=8681de8b88a8db15b82606b4";
const IOS_LINK =
  "hu-sandbox-com-example-app://hot-updater/preview?channel=pr-12&fingerprint=ea472e2231256899c3e6fc35";
const ANDROID_QR =
  "https://github.com/octo/app/raw/hot-updater-preview/pr-12/aaaaaaaaaaaaaaaa.png";
const IOS_QR =
  "https://github.com/octo/app/raw/hot-updater-preview/pr-12/bbbbbbbbbbbbbbbb.png";
const sandbox = (link: string) =>
  ({ appId: "com.example.app", link, minBundleId: null }) as const;
const androidSandbox = { ...android, sandbox: sandbox(ANDROID_LINK) } as const;
const iosSandboxOnTestFlight = {
  ...ipaOnTestFlight,
  sandbox: sandbox(IOS_LINK),
} as const;
const aabSandboxOnPlay = {
  ...aabOnPlay,
  sandbox: sandbox(ANDROID_LINK),
} as const;
const ipa = {
  ...ios,
  nativeBuild: { ...ios.nativeBuild, artifactKind: "ipa", fileName: "App.ipa" },
} as const;

describe("renderPreviewComment", () => {
  it("walks a tester through installing the sandbox app, then scanning this pull request's QR code", () => {
    expect(
      renderPreviewComment({
        ...base,
        previews: [androidSandbox, iosSandboxOnTestFlight],
        qrImages: { [ANDROID_LINK]: ANDROID_QR, [IOS_LINK]: IOS_QR },
      }),
    ).toBe(`<!-- hot-updater-preview -->

### Preview on \`pr-12\`

**1. Install the sandbox app** once. Pull requests with the same native code share it.

- **Android**: [Download APK](${C}/api/native-builds/019a0000-0000-7000-8000-00000000b001/download) · [Details](${C}/native-builds/019a0000-0000-7000-8000-00000000b001) · allow "Install unknown apps" when Android asks
- **iOS**: [TestFlight](https://appstoreconnect.apple.com/apps/6764/testflight/ios) · \`1.7.0 (66)\` · processing · [Details](${C}/native-builds/019a0000-0000-7000-8000-00000000b003)

This run made a new sandbox build: push the other open pull requests again.

**2. Scan to open this pull request** with the sandbox app.

**Android**

<img src="${ANDROID_QR}" alt="QR code of the sandbox link of pr-12" width="180" height="180">

\`${ANDROID_LINK}\`

**iOS**

<img src="${IOS_QR}" alt="QR code of the sandbox link of pr-12" width="180" height="180">

\`${IOS_LINK}\`

<details>
<summary>Builds</summary>

| Platform | Native build | Fingerprint | Bundle |
| --- | --- | --- | --- |
| Android | \`019a0000-0000-7000-8000-00000000b001\` · built for this commit | \`8681de8b88a8\` | \`019a0000-0000-7000-8000-0000000000a1\` |
| iOS | \`019a0000-0000-7000-8000-00000000b003\` · reused | \`ea472e223125\` | \`019a0000-0000-7000-8000-0000000000a2\` |

</details>

<details>
<summary>Install on an emulator or simulator</summary>

Download the build, then:

\`\`\`sh
adb install -r app-release.apk
\`\`\`

</details>

<sub>Deployed \`0123456\` · Preview by [hot-updater](https://hot-updater.dev)</sub>`);
  });

  it("links each pull request build, with no QR code, when there's no sandbox build", () => {
    expect(renderPreviewComment({ ...base, previews: [android, ios] }))
      .toBe(`<!-- hot-updater-preview -->

### Preview on \`pr-12\`

**Install this pull request's build.** It opens this pull request on its first launch.

- **Android**: [Download APK](${C}/api/native-builds/019a0000-0000-7000-8000-00000000b001/download) · [Details](${C}/native-builds/019a0000-0000-7000-8000-00000000b001) · allow "Install unknown apps" when Android asks
- **iOS Simulator**: [Details](${C}/native-builds/019a0000-0000-7000-8000-00000000b002) · install with the command below

<details>
<summary>Builds</summary>

| Platform | Native build | Fingerprint | Bundle |
| --- | --- | --- | --- |
| Android | \`019a0000-0000-7000-8000-00000000b001\` · built for this commit | \`8681de8b88a8\` | \`019a0000-0000-7000-8000-0000000000a1\` |
| iOS Simulator | \`019a0000-0000-7000-8000-00000000b002\` · reused | \`ea472e223125\` | \`019a0000-0000-7000-8000-0000000000a2\` |

</details>

<details>
<summary>Install on an emulator or simulator</summary>

Download the build, then:

\`\`\`sh
adb install -r app-release.apk
\`\`\`

In your project, this downloads the build, installs it on the booted Simulator, and opens it:

\`\`\`sh
npx hot-updater native-build install 019a0000-0000-7000-8000-00000000b002
\`\`\`

</details>

<sub>Deployed \`0123456\` · Preview by [hot-updater](https://hot-updater.dev)</sub>`);
  });

  it("names each platform's own store, never the other's", () => {
    const body = renderPreviewComment({
      ...base,
      previews: [aabSandboxOnPlay, iosSandboxOnTestFlight],
    });

    expect(body).toContain(
      `- **Android**: [Google Play internal testing](${aabOnPlay.store.url}) · \`1.7.0 (42)\` · a draft: roll it out in Play Console · [Details](${C}/native-builds/${aabOnPlay.nativeBuild.id})\n- **iOS**: [TestFlight](${onStore.url}) · `,
    );
    expect(body).not.toContain("Testers install");
    expect(body).not.toContain("adb install");
  });

  it("names a store without a link when it couldn't be read", () => {
    const body = renderPreviewComment({
      ...base,
      previews: [
        {
          ...iosSandboxOnTestFlight,
          store: { ...onStore, url: null, state: null },
        },
      ],
    });

    expect(body).toContain(
      `- **iOS**: TestFlight · \`1.7.0 (66)\` · [Details](${C}/native-builds/${ipaOnTestFlight.nativeBuild.id})`,
    );
  });

  it("links an IPA's install page and file, with no QR code", () => {
    const body = renderPreviewComment({ ...base, previews: [ipa] });

    expect(body).toContain(
      `- **iOS**: [Install on iPhone](${C}/native-builds/${ipa.nativeBuild.id}) · [Download IPA](${C}/api/native-builds/${ipa.nativeBuild.id}/download) · registered devices only`,
    );
    expect(body).not.toContain("<img");
    expect(body).not.toContain("Scan");
    expect(body).not.toContain("<summary>Install on an emulator");
  });

  it("puts a platform's own build after the sandbox steps", () => {
    const body = renderPreviewComment({
      ...base,
      previews: [androidSandbox, ios],
      qrImages: { [ANDROID_LINK]: ANDROID_QR },
    });

    const scan = body.indexOf("**2. Scan to open this pull request**");
    const own = body.indexOf(
      `**This pull request's own build** opens this pull request on its first launch.\n\n- **iOS Simulator**: [Details](${C}/native-builds/${ios.nativeBuild.id}) · install with the command below`,
    );
    expect(scan).toBeGreaterThan(0);
    expect(own).toBeGreaterThan(scan);
  });

  it("says when the sandbox build floors out the bundle", () => {
    const body = renderPreviewComment({
      ...base,
      previews: [
        {
          ...androidSandbox,
          sandbox: {
            ...androidSandbox.sandbox,
            minBundleId: "019a0000-0000-7000-8000-00000000ffff",
          },
        },
      ],
      qrImages: { [ANDROID_LINK]: ANDROID_QR },
    });

    expect(body).toContain(
      "Bundle `019a0000-0000-7000-8000-0000000000a1` is older than the sandbox build accepts: push again.",
    );
  });

  it("keeps a Console's own path in its links", () => {
    const body = renderPreviewComment({
      ...base,
      consoleUrl: "https://example.com/console",
      previews: [android],
    });

    expect(body).toContain(
      '[Download APK](https://example.com/console/api/native-builds/019a0000-0000-7000-8000-00000000b001/download) · [Details](https://example.com/console/native-builds/019a0000-0000-7000-8000-00000000b001) · allow "Install unknown apps" when Android asks',
    );
  });

  it("doesn't tell a simulator build to download first, since its command does", () => {
    const body = renderPreviewComment({ ...base, previews: [ios] });

    expect(body).toContain(
      "npx hot-updater native-build install 019a0000-0000-7000-8000-00000000b002",
    );
    expect(body).not.toContain("Download the build, then:");
    expect(body).not.toMatch(/xcrun|simctl|unzip/);
  });

  it("keeps an APK's download and adb command as they are", () => {
    const body = renderPreviewComment({ ...base, previews: [android] });

    expect(body).toContain(`<details>
<summary>Install on an emulator or simulator</summary>

Download the build, then:

\`\`\`sh
adb install -r app-release.apk
\`\`\`

</details>`);
    expect(body).not.toContain("native-build install");
  });

  it("drops the credit line when credit is off", () => {
    const body = renderPreviewComment({
      ...base,
      previews: [android],
      credit: false,
    });

    expect(body).not.toContain("Preview by");
    expect(body).not.toContain("hot-updater.dev");
    expect(body.endsWith("<sub>Deployed `0123456`</sub>")).toBe(true);
  });

  it("shows the app version when the builds are matched by it", () => {
    const body = renderPreviewComment({
      ...base,
      previews: [
        { ...android, target: { fingerprintHash: null, appVersion: "1.4.0" } },
      ],
    });

    expect(body).toContain(
      "| Platform | Native build | App version | Bundle |",
    );
    expect(body).toContain("| `1.4.0` |");
    expect(body).not.toContain("Fingerprint");
  });

  it("names both targets when the platforms use different strategies", () => {
    const body = renderPreviewComment({
      ...base,
      previews: [
        android,
        { ...ios, target: { fingerprintHash: null, appVersion: "1.4.0" } },
      ],
    });

    expect(body).toContain(
      "| Platform | Native build | Fingerprint or app version | Bundle |",
    );
    expect(body).toContain("| `8681de8b88a8` |");
    expect(body).toContain("| `1.4.0` |");
  });

  it("quotes an artifact name a shell would read otherwise", () => {
    const body = renderPreviewComment({
      ...base,
      previews: [
        {
          ...android,
          nativeBuild: { ...android.nativeBuild, fileName: "my app's.apk" },
        },
      ],
    });

    expect(body).toContain("adb install -r 'my app'\\''s.apk'");
  });
});

describe("nativeBuildInstallUrl", () => {
  it.each(["apk", "aab", "ipa"] as const)(
    "is the Console's download link, under its own path, for an %s",
    (artifactKind) => {
      expect(
        nativeBuildInstallUrl("https://example.com/console/", {
          id: "build 1",
          artifactKind,
        }),
      ).toBe(
        "https://example.com/console/api/native-builds/build%201/download",
      );
    },
  );

  it("is the install command for a simulator build, as the Console shows it", () => {
    expect(
      nativeBuildInstallUrl("https://example.com", {
        id: "019a0000-0000-7000-8000-00000000b002",
        artifactKind: "app",
      }),
    ).toBe(
      "npx hot-updater native-build install 019a0000-0000-7000-8000-00000000b002",
    );
    expect(
      nativeBuildInstallUrl("https://example.com", {
        id: "build 1",
        artifactKind: "app",
      }),
    ).toBe("npx hot-updater native-build install 'build 1'");
  });
});

describe("renderClosedComment", () => {
  it("says the channel, its bundles, and its native builds are deleted", () => {
    expect(
      renderClosedComment({
        channel: "pr-12",
        outcome: "deleted",
        deletedBundles: 3,
        deletedNativeBuilds: 2,
        credit: true,
      }),
    ).toBe(`<!-- hot-updater-preview -->

### Preview on \`pr-12\`

This pull request is closed: its channel \`pr-12\`, its 3 bundles, and its 2 native builds are deleted.

<sub>Preview by [hot-updater](https://hot-updater.dev)</sub>`);
  });

  it("says why a channel is kept, without a credit line when it is off", () => {
    expect(
      renderClosedComment({
        channel: "pr-12",
        outcome: "kept",
        deletedBundles: 1,
        deletedNativeBuilds: 1,
        credit: false,
      }),
    ).toBe(`<!-- hot-updater-preview -->

### Preview on \`pr-12\`

This pull request is closed: its 1 bundle and its 1 native build are deleted, and its channel \`pr-12\` is kept, because a bundle or a build was added to it during the cleanup. Run the cleanup again.`);
  });

  it("says when the channel was already gone", () => {
    expect(
      renderClosedComment({
        channel: "pr-12",
        outcome: "missing",
        deletedBundles: 0,
        deletedNativeBuilds: 0,
        credit: true,
      }),
    ).toContain(
      "This pull request is closed, and its channel `pr-12` is already deleted.",
    );
  });
});

describe("shellQuote", () => {
  it.each([
    ["pr-12", "pr-12"],
    ["app-release.apk", "app-release.apk"],
    ["My App.app.zip", "'My App.app.zip'"],
    ["it's", "'it'\\''s'"],
  ])("quotes %j as %j", (value, quoted) => {
    expect(shellQuote(value)).toBe(quoted);
  });
});

describe("the sandbox link's QR code", () => {
  it("is the only QR code: native builds get links", () => {
    expect(
      qrCodeValues([androidSandbox, android, ipa, ios, iosSandboxOnTestFlight]),
    ).toEqual([ANDROID_LINK, IOS_LINK]);
  });

  it("says to open the link, not to scan it, when there's no image", () => {
    const body = renderPreviewComment({ ...base, previews: [androidSandbox] });

    expect(body).not.toContain("Scan");
    expect(body).not.toContain("<img");
    expect(body).toContain(
      `**2. Open this pull request**: open the link on the phone with the sandbox app.\n\n**Android**\n\n\`${ANDROID_LINK}\``,
    );
  });
});
