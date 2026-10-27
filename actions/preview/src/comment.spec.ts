import { describe, expect, it } from "vitest";

import {
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
  },
  built: false,
  bundleId: "019a0000-0000-7000-8000-0000000000a2",
} as const;

describe("renderPreviewComment", () => {
  it("lists each platform's download and page links and bundle, and the channel link's QR code", () => {
    expect(
      renderPreviewComment({
        consoleUrl: "https://console.example.com/",
        channel: "pr-12",
        previewChannel: "preview",
        previews: [android, ios],
        channelLink: {
          link: "myapp://hot-updater/channel/pr-12",
          qrCode: true,
        },
        headSha: "0123456789abcdef",
        credit: true,
      }),
    ).toBe(`<!-- hot-updater-preview -->

### Preview on \`pr-12\`

| Platform | Native build | Fingerprint | Bundle |
| --- | --- | --- | --- |
| Android | [Download](https://console.example.com/api/native-builds/019a0000-0000-7000-8000-00000000b001/download) · [Details](https://console.example.com/native-builds/019a0000-0000-7000-8000-00000000b001) · built for this commit | \`8681de8b88a8\` | \`019a0000-0000-7000-8000-0000000000a1\` |
| iOS Simulator | [Download](https://console.example.com/api/native-builds/019a0000-0000-7000-8000-00000000b002/download) · [Details](https://console.example.com/native-builds/019a0000-0000-7000-8000-00000000b002) · reused | \`ea472e223125\` | \`019a0000-0000-7000-8000-0000000000a2\` |

Preview builds embed the \`preview\` channel, and each pull request deploys to its own.

Scan the QR code with a device that has a preview build installed to open this pull request's bundle, or open the link:

<img src="https://console.example.com/_hot-updater/preview/channel-qr?channel=pr-12" alt="QR code of myapp://hot-updater/channel/pr-12" width="180" height="180">

\`myapp://hot-updater/channel/pr-12\`

<details>
<summary>Open it on an emulator or simulator</summary>

\`\`\`sh
adb shell am start -a android.intent.action.VIEW -d myapp://hot-updater/channel/pr-12
xcrun simctl openurl booted myapp://hot-updater/channel/pr-12
\`\`\`

</details>

<sub>Deployed \`0123456\` · Preview by [hot-updater](https://hot-updater.dev)</sub>`);
  });

  it("drops the credit line when credit is off", () => {
    const body = renderPreviewComment({
      consoleUrl: "https://console.example.com",
      channel: "pr-12",
      previewChannel: "preview",
      previews: [android],
      channelLink: { link: "myapp://hot-updater/channel/pr-12", qrCode: true },
      headSha: "0123456789abcdef",
      credit: false,
    });

    expect(body).not.toContain("Preview by");
    expect(body).not.toContain("hot-updater.dev");
    expect(body.endsWith("<sub>Deployed `0123456`</sub>")).toBe(true);
  });

  it("shows the link and its commands without a QR code when the Console serves the runner none", () => {
    const body = renderPreviewComment({
      consoleUrl: "https://console.internal.example.com",
      channel: "pr-12",
      previewChannel: "preview",
      previews: [android],
      channelLink: { link: "myapp://hot-updater/channel/pr-12", qrCode: false },
      headSha: "0123456789abcdef",
      credit: true,
    });

    expect(body).not.toContain("<img");
    expect(body).not.toContain("channel-qr");
    expect(body)
      .toContain(`Open the link on a device that has a preview build installed to open this pull request's bundle:

\`myapp://hot-updater/channel/pr-12\`

<details>
<summary>Open it on an emulator or simulator</summary>

\`\`\`sh
adb shell am start -a android.intent.action.VIEW -d myapp://hot-updater/channel/pr-12
xcrun simctl openurl booted myapp://hot-updater/channel/pr-12
\`\`\`

</details>`);
  });

  it("names the config option when no config sets a channel link prefix", () => {
    const body = renderPreviewComment({
      consoleUrl: "https://example.com/console",
      channel: "pr-7",
      previewChannel: "preview",
      previews: [android],
      channelLink: null,
      headSha: "0123456789abcdef",
      credit: true,
    });

    expect(body).not.toContain("<img");
    expect(body).not.toContain("adb shell");
    expect(body).toContain(
      "Set `console.channelLinkPrefix` to show the channel link that opens this pull request's bundle in a preview build.",
    );
    expect(body).toContain(
      "[Download](https://example.com/console/api/native-builds/019a0000-0000-7000-8000-00000000b001/download) · [Details](https://example.com/console/native-builds/019a0000-0000-7000-8000-00000000b001)",
    );
  });

  it("shows the app version when the builds are matched by it", () => {
    const body = renderPreviewComment({
      consoleUrl: "https://console.example.com",
      channel: "pr-12",
      previewChannel: "preview",
      previews: [
        { ...android, target: { fingerprintHash: null, appVersion: "1.4.0" } },
      ],
      channelLink: null,
      headSha: "0123456789abcdef",
      credit: true,
    });

    expect(body).toContain(
      "| Platform | Native build | App version | Bundle |",
    );
    expect(body).toContain("| `1.4.0` |");
    expect(body).not.toContain("Fingerprint");
  });

  it("names both targets when the platforms use different strategies", () => {
    const body = renderPreviewComment({
      consoleUrl: "https://console.example.com",
      channel: "pr-12",
      previewChannel: "preview",
      previews: [
        android,
        { ...ios, target: { fingerprintHash: null, appVersion: "1.4.0" } },
      ],
      channelLink: null,
      headSha: "0123456789abcdef",
      credit: true,
    });

    expect(body).toContain(
      "| Platform | Native build | Fingerprint or app version | Bundle |",
    );
    expect(body).toContain("| `8681de8b88a8` |");
    expect(body).toContain("| `1.4.0` |");
  });

  it("encodes a channel name in the links, and quotes it in the commands", () => {
    const body = renderPreviewComment({
      consoleUrl: "https://console.example.com",
      channel: "pr 12's",
      previewChannel: "preview",
      previews: [android],
      channelLink: {
        link: "myapp://hot-updater/channel/pr%2012's",
        qrCode: true,
      },
      headSha: "0123456789abcdef",
      credit: true,
    });

    expect(body).toContain(
      'src="https://console.example.com/_hot-updater/preview/channel-qr?channel=pr+12%27s"',
    );
    expect(body).toContain(
      "xcrun simctl openurl booted 'myapp://hot-updater/channel/pr%2012'\\''s'",
    );
  });

  it("never says Expo Go", () => {
    const body = renderPreviewComment({
      consoleUrl: "https://console.example.com",
      channel: "pr-12",
      previewChannel: "preview",
      previews: [android, ios],
      channelLink: { link: "myapp://hot-updater/channel/pr-12", qrCode: true },
      headSha: "0123456789abcdef",
      credit: true,
    });

    expect(body).not.toMatch(/expo go/i);
  });
});

describe("renderClosedComment", () => {
  it("says the channel and its bundles are deleted", () => {
    expect(
      renderClosedComment({
        channel: "pr-12",
        outcome: "deleted",
        deletedBundles: 3,
        credit: true,
      }),
    ).toBe(`<!-- hot-updater-preview -->

### Preview on \`pr-12\`

This pull request is closed: its channel \`pr-12\` and its 3 bundles are deleted.

<sub>Preview by [hot-updater](https://hot-updater.dev)</sub>`);
  });

  it("says why a channel a native build embeds is kept, without a credit line when it is off", () => {
    expect(
      renderClosedComment({
        channel: "pr-12",
        outcome: "kept",
        deletedBundles: 1,
        credit: false,
      }),
    ).toBe(`<!-- hot-updater-preview -->

### Preview on \`pr-12\`

This pull request is closed: its 1 bundle is deleted, and its channel \`pr-12\` is kept, because a native build embeds it. Register preview builds on one shared channel, and deploy each pull request to its own.`);
  });

  it("says when the channel was already gone", () => {
    expect(
      renderClosedComment({
        channel: "pr-12",
        outcome: "missing",
        deletedBundles: 0,
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
    ["myapp://hot-updater/channel/pr-12", "myapp://hot-updater/channel/pr-12"],
    ["myapp://x?a=1&b=2", "'myapp://x?a=1&b=2'"],
    ["it's", "'it'\\''s'"],
  ])("quotes %j as %j", (value, quoted) => {
    expect(shellQuote(value)).toBe(quoted);
  });
});
