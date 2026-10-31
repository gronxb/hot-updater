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
  qrCodes: [] as string[],
  headSha: "0123456789abcdef",
  credit: true,
};

describe("renderPreviewComment", () => {
  it("lists each platform's download and page, the APK's download QR code, and the install commands", () => {
    expect(
      renderPreviewComment({
        ...base,
        previews: [android, ios],
        qrCodes: [android.nativeBuild.id],
      }),
    ).toBe(`<!-- hot-updater-preview -->

### Preview on \`pr-12\`

| Platform | Native build | Fingerprint | Bundle |
| --- | --- | --- | --- |
| Android | [Download](https://console.example.com/api/native-builds/019a0000-0000-7000-8000-00000000b001/download) · [Details](https://console.example.com/native-builds/019a0000-0000-7000-8000-00000000b001) · built for this commit | \`8681de8b88a8\` | \`019a0000-0000-7000-8000-0000000000a1\` |
| iOS Simulator | [Download](https://console.example.com/api/native-builds/019a0000-0000-7000-8000-00000000b002/download) · [Details](https://console.example.com/native-builds/019a0000-0000-7000-8000-00000000b002) · reused | \`ea472e223125\` | \`019a0000-0000-7000-8000-0000000000a2\` |

This pull request's native builds embed the \`pr-12\` channel, so they open its bundle on their first launch.

Scan with an Android phone to download the APK. The phone signs in to the Console first, and for a private Console it has to be on the Console's network.

<img src="https://console.example.com/_hot-updater/native-builds/qr?build=019a0000-0000-7000-8000-00000000b001" alt="QR code of the download of app-release.apk" width="180" height="180">

<details>
<summary>Install on an emulator or simulator</summary>

Download the build, then:

\`\`\`sh
adb install -r app-release.apk
unzip -o HotUpdaterExample.app.zip && xcrun simctl install booted HotUpdaterExample.app
\`\`\`

</details>

<sub>Deployed \`0123456\` · Preview by [hot-updater](https://hot-updater.dev)</sub>`);
  });

  it("shows no QR code for a build the runner found no QR code of", () => {
    const body = renderPreviewComment({ ...base, previews: [android] });

    expect(body).not.toContain("<img");
    expect(body).not.toContain("Scan with");
    expect(body).toContain(
      "[Download](https://console.example.com/api/native-builds/019a0000-0000-7000-8000-00000000b001/download)",
    );
  });

  it("keeps a Console's own path in its links", () => {
    const body = renderPreviewComment({
      ...base,
      consoleUrl: "https://example.com/console",
      previews: [android],
      qrCodes: [android.nativeBuild.id],
    });

    expect(body).toContain(
      "[Details](https://example.com/console/native-builds/019a0000-0000-7000-8000-00000000b001)",
    );
    expect(body).toContain(
      'src="https://example.com/console/_hot-updater/native-builds/qr?build=019a0000-0000-7000-8000-00000000b001"',
    );
  });

  it("points an IPA's testers to TestFlight, with no install command or QR code", () => {
    const ipa = {
      ...ios,
      nativeBuild: {
        ...ios.nativeBuild,
        artifactKind: "ipa",
        fileName: "App.ipa",
      },
    } as const;
    const body = renderPreviewComment({ ...base, previews: [ipa] });

    expect(body).toContain("| iOS |");
    expect(body).toContain("`npx hot-updater testflight`");
    expect(body).not.toContain("<details>");
    expect(body).not.toContain("<img");
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

  it("shows no channel link", () => {
    const body = renderPreviewComment({
      ...base,
      previews: [android, ios],
      qrCodes: [android.nativeBuild.id],
    });

    expect(body).not.toMatch(
      /hot-updater\/channel\/|openurl|am start|channel-qr/,
    );
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
