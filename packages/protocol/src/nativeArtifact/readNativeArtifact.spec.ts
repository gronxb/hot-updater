import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  blobSource,
  bytesSource,
  type ByteSource,
  NativeArtifactError,
} from "./byteSource";
import {
  alreadyImportedProblem,
  checkNativeArtifact,
  sandboxArtifactProblem,
} from "./checkNativeArtifact";
import {
  type NativeArtifactInfo,
  nativeArtifactKindOf,
  readNativeArtifact,
} from "./readNativeArtifact";
import {
  isSandboxChannel,
  sandboxChannelOf,
  sandboxUrlSchemeOf,
} from "./sandbox";
import { openZipEntry, readZipDirectory } from "./zip";

// The values __fixtures__/generate.sh compiled into the fixtures with javac,
// d8, aapt2, clang and plutil: the oracle these readers are checked against.
const MIN_BUNDLE_ID = "019a2b3c-4d5e-7000-8000-000000000000";
const OTHER_UUID_V7 = "019a2b3c-4d5e-7abc-9def-0123456789ab";
const FINGERPRINT =
  "5de1cdbfefdc1f0b4a1b3c36ed83c246dff317dd540c0393ca76fa758026ec8f";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string) => readFileSync(join(fixtures, name));

const BUNDLE = new TextEncoder().encode('console.log("built-in");\n');

/** A zip archive of `files`, deflated unless a name is in `stored`. */
const zip = async (
  files: Record<string, Uint8Array | string>,
  stored: readonly string[] = [],
): Promise<Uint8Array> => {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    archive.file(name, content, {
      compression: stored.includes(name) ? "STORE" : "DEFLATE",
    });
  }
  return archive.generateAsync({ type: "uint8array" });
};

const read = async (files: Record<string, Uint8Array | string>, name: string) =>
  readNativeArtifact(bytesSource(await zip(files)), name);

const apk = (overrides: Record<string, Uint8Array | string> = {}) => ({
  "AndroidManifest.xml": fixture("release.axml"),
  "classes.dex": fixture("classes.dex"),
  "assets/index.android.bundle": BUNDLE,
  ...overrides,
});

const aab = (overrides: Record<string, Uint8Array | string> = {}) => ({
  "base/manifest/AndroidManifest.xml": fixture("release.pb"),
  "base/dex/classes.dex": fixture("classes.dex"),
  "base/assets/index.android.bundle": BUNDLE,
  ...overrides,
});

const ipa = (overrides: Record<string, Uint8Array | string> = {}) => ({
  "Payload/App.app/Info.plist": fixture("Info.plist"),
  "Payload/App.app/App": fixture("App"),
  "Payload/App.app/main.jsbundle": BUNDLE,
  ...overrides,
});

const RELEASE_ANDROID = {
  platform: "android",
  appId: "com.example.app",
  appVersion: "1.4.0",
  buildNumber: "42",
  channel: "beta",
  minBundleIdCandidates: [MIN_BUNDLE_ID],
  fingerprintCandidates: [FINGERPRINT],
  sandbox: { code: false, declared: false },
} as const;

describe("readNativeArtifact", () => {
  it("reads an .apk's binary manifest and its dex string pool", async () => {
    expect(await read(apk(), "app-release.apk")).toEqual({
      ...RELEASE_ANDROID,
      kind: "apk",
      builtInBundle: {
        path: "assets/index.android.bundle",
        byteSize: BUNDLE.byteLength,
      },
    });
  });

  it("reads an .aab's proto manifest and its base module's dex", async () => {
    expect(await read(aab(), "app-release.aab")).toEqual({
      ...RELEASE_ANDROID,
      kind: "aab",
      builtInBundle: {
        path: "base/assets/index.android.bundle",
        byteSize: BUNDLE.byteLength,
      },
    });
  });

  it("reads entries stored without compression", async () => {
    const bytes = await zip(apk(), ["classes.dex", "AndroidManifest.xml"]);
    const info = await readNativeArtifact(bytesSource(bytes), "a.apk");
    expect(info.minBundleIdCandidates).toEqual([MIN_BUNDLE_ID]);
    expect(info.appId).toBe("com.example.app");
  });

  it.each([
    ["apk", apk({ "AndroidManifest.xml": fixture("debuggable.axml") })],
    [
      "aab",
      aab({ "base/manifest/AndroidManifest.xml": fixture("debuggable.pb") }),
    ],
  ] as const)(
    "reads no channel from an .%s without the channel meta-data",
    async (kind, files) => {
      const info = await read(files, `app.${kind}`);
      expect(info.channel).toBeNull();
      // android:debuggable changes nothing: a release variant made
      // debuggable still compiles the SDK's release code, which reports
      // the built-in bundle.
      expect(
        checkNativeArtifact(info, { updateStrategy: "fingerprint" }),
      ).toMatchObject({ ok: true, build: { channel: "production" } });
    },
  );

  it.each([
    ["apk", apk({ "AndroidManifest.xml": fixture("empty.axml") })],
    ["aab", aab({ "base/manifest/AndroidManifest.xml": fixture("empty.pb") })],
  ] as const)(
    "reads an empty channel meta-data in an .%s as none, which the SDK reports as production",
    async (kind, files) => {
      const info = await read(files, `app.${kind}`);
      expect(info.channel).toBeNull();
      expect(
        checkNativeArtifact(info, { updateStrategy: "fingerprint" }),
      ).toMatchObject({ ok: true, build: { channel: "production" } });
    },
  );

  it.each([
    ["apk", apk({ "AndroidManifest.xml": fixture("reference.axml") })],
    [
      "aab",
      aab({ "base/manifest/AndroidManifest.xml": fixture("reference.pb") }),
    ],
    // android:resource rather than android:value.
    ["apk", apk({ "AndroidManifest.xml": fixture("resource.axml") })],
    [
      "aab",
      aab({ "base/manifest/AndroidManifest.xml": fixture("resource.pb") }),
    ],
  ] as const)(
    "reads a channel given as a resource reference in an .%s as unreadable",
    async (kind, files) => {
      const { channel } = await read(files, `app.${kind}`);
      expect(channel).toEqual({
        unreadable: expect.stringContaining("resource reference"),
      });
    },
  );

  it("collects UUIDv7 literals across every dex, and no substrings", async () => {
    const info = await read(
      apk({ "classes2.dex": fixture("other.dex") }),
      "a.apk",
    );
    // "id=<OTHER_UUID_V7>" in classes.dex is no whole literal; other.dex
    // returns it whole.
    expect(info.minBundleIdCandidates).toEqual([MIN_BUNDLE_ID, OTHER_UUID_V7]);
    expect((await read(apk(), "a.apk")).minBundleIdCandidates).not.toContain(
      OTHER_UUID_V7,
    );
  });

  it("reads an .ipa's binary Info.plist and its executable's C strings", async () => {
    expect(await read(ipa(), "App.ipa")).toEqual({
      platform: "ios",
      kind: "ipa",
      appId: "com.example.app",
      appVersion: "1.4.0",
      buildNumber: "42",
      channel: "beta & gamma",
      minBundleIdCandidates: [MIN_BUNDLE_ID],
      fingerprintCandidates: [FINGERPRINT],
      sandbox: { code: false, declared: false },
      builtInBundle: {
        path: "Payload/App.app/main.jsbundle",
        byteSize: BUNDLE.byteLength,
      },
    });
  });

  it("reads an XML Info.plist as it reads a binary one", async () => {
    const xml = await read(
      ipa({ "Payload/App.app/Info.plist": fixture("Info.xml.plist") }),
      "App.ipa",
    );
    expect(xml).toEqual(await read(ipa(), "App.ipa"));
  });

  it("reads a universal binary by its arm64 slice", async () => {
    const info = await read(
      ipa({ "Payload/App.app/App": fixture("App-universal") }),
      "App.ipa",
    );
    // The x86_64 slice holds OTHER_UUID_V7.
    expect(info.minBundleIdCandidates).toEqual([MIN_BUNDLE_ID]);
  });

  it("reads HotUpdater's dynamic framework alone, whatever UUIDv7 the executable holds", async () => {
    const info = await read(
      ipa({
        // The app's own code holds an unrelated UUIDv7.
        "Payload/App.app/App": fixture("App-other"),
        "Payload/App.app/Frameworks/HotUpdater.framework/HotUpdater":
          fixture("App"),
        // A framework's resource is no framework binary.
        "Payload/App.app/Frameworks/HotUpdater.framework/Info.plist":
          fixture("Info.plist"),
      }),
      "App.ipa",
    );
    expect(info.minBundleIdCandidates).toEqual([MIN_BUNDLE_ID]);
  });

  it("reads every framework when neither HotUpdater's nor the executable holds one, and keeps them all", async () => {
    const one = await read(
      ipa({
        "Payload/App.app/App": "not a Mach-O binary",
        "Payload/App.app/Frameworks/Sdk.framework/Sdk": fixture("App"),
      }),
      "App.ipa",
    );
    expect(one.minBundleIdCandidates).toEqual([MIN_BUNDLE_ID]);
    const two = await read(
      ipa({
        "Payload/App.app/App": "not a Mach-O binary",
        "Payload/App.app/Frameworks/Sdk.framework/Sdk": fixture("App"),
        "Payload/App.app/Frameworks/Other.framework/Other":
          fixture("App-other"),
      }),
      "App.ipa",
    );
    expect(two.minBundleIdCandidates).toEqual([MIN_BUNDLE_ID, OTHER_UUID_V7]);
  });

  it("reads no built-in bundle from an artifact without one", async () => {
    const files = ipa();
    delete (files as Record<string, unknown>)["Payload/App.app/main.jsbundle"];
    expect((await read(files, "App.ipa")).builtInBundle).toBeNull();
  });

  it("refuses a file that is no .ipa, .aab or .apk, and one that is no zip", async () => {
    await expect(
      readNativeArtifact(bytesSource(await zip(apk())), "app.zip"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
    await expect(
      readNativeArtifact(bytesSource(BUNDLE), "app.apk"),
    ).rejects.toBeInstanceOf(NativeArtifactError);
    await expect(
      readNativeArtifact(bytesSource(await zip({ a: "b" })), "app.ipa"),
    ).rejects.toMatchObject({ code: "UNREADABLE" });
  });

  it("reads a Blob as it reads bytes", async () => {
    const bytes = await zip(aab());
    expect(
      await readNativeArtifact(blobSource(new Blob([bytes])), "a.aab"),
    ).toEqual(await readNativeArtifact(bytesSource(bytes), "a.aab"));
  });
});

describe("openZipEntry", () => {
  it("streams an entry larger than one read, byte for byte", async () => {
    // Incompressible bytes, so the deflated entry spans several reads.
    const large = new Uint8Array(3 * 1024 * 1024 + 7);
    for (let i = 0; i < large.length; i += 65536) {
      crypto.getRandomValues(large.subarray(i, i + 65536));
    }
    const source: ByteSource = bytesSource(
      await zip({ "assets/index.android.bundle": large }),
    );
    const entry = (await readZipDirectory(source)).find(
      ({ name }) => name === "assets/index.android.bundle",
    );
    expect(entry!.compressedSize).toBeGreaterThan(2 * 1024 * 1024);
    const chunks: Uint8Array[] = [];
    const reader = (await openZipEntry(source, entry!)).getReader();
    for (
      let next = await reader.read();
      !next.done;
      next = await reader.read()
    ) {
      chunks.push(next.value);
    }
    const out = Buffer.concat(chunks);
    expect(out.byteLength).toBe(large.byteLength);
    expect(Buffer.compare(out, large)).toBe(0);
  });
});

const info = (overrides: Partial<NativeArtifactInfo>): NativeArtifactInfo => ({
  ...RELEASE_ANDROID,
  kind: "aab",
  builtInBundle: {
    path: "base/assets/index.android.bundle",
    byteSize: 1,
  },
  ...overrides,
});

const codes = (result: ReturnType<typeof checkNativeArtifact>) =>
  result.ok ? [] : result.problems.map(({ code }) => code);

describe("checkNativeArtifact", () => {
  it("registers a release build by its fingerprint or its app version", () => {
    expect(
      checkNativeArtifact(info({}), { updateStrategy: "fingerprint" }),
    ).toEqual({
      ok: true,
      warnings: [],
      build: {
        platform: "android",
        kind: "aab",
        appId: "com.example.app",
        buildNumber: "42",
        minBundleId: MIN_BUNDLE_ID,
        channel: "beta",
        fingerprintHash: FINGERPRINT,
        appVersion: null,
        builtInBundlePath: "base/assets/index.android.bundle",
      },
    });
    const byVersion = checkNativeArtifact(info({ channel: null }), {
      updateStrategy: "appVersion",
    });
    expect(byVersion).toMatchObject({
      ok: true,
      build: {
        fingerprintHash: null,
        appVersion: "1.4.0",
        channel: "production",
      },
    });
  });

  it.each([
    [{ builtInBundle: null }, "fingerprint", "NO_BUILT_IN_BUNDLE"],
    [{ minBundleIdCandidates: [] }, "fingerprint", "NO_MIN_BUNDLE_ID"],
    [
      { minBundleIdCandidates: [MIN_BUNDLE_ID, OTHER_UUID_V7] },
      "fingerprint",
      "AMBIGUOUS_MIN_BUNDLE_ID",
    ],
    [{ fingerprintCandidates: [] }, "fingerprint", "NO_FINGERPRINT"],
    [
      { fingerprintCandidates: [FINGERPRINT, "a".repeat(64)] },
      "fingerprint",
      "AMBIGUOUS_FINGERPRINT",
    ],
    [{ appVersion: null }, "appVersion", "NO_APP_VERSION"],
    [
      { appVersion: { unreadable: "versionName is a resource reference" } },
      "appVersion",
      "NO_APP_VERSION",
    ],
    [{ appVersion: "beta" }, "appVersion", "INVALID_SCOPE"],
    [{ channel: " padded " }, "fingerprint", "INVALID_SCOPE"],
    [
      { channel: { unreadable: "The channel is a resource reference" } },
      "fingerprint",
      "INVALID_SCOPE",
    ],
  ] as const)("refuses %j under %s with %s", (overrides, strategy, code) => {
    expect(
      codes(
        checkNativeArtifact(info(overrides as Partial<NativeArtifactInfo>), {
          updateStrategy: strategy,
        }),
      ),
    ).toEqual([code]);
  });

  it("ignores a fingerprint under the appVersion strategy, which the app doesn't check by", () => {
    expect(
      checkNativeArtifact(info({ fingerprintCandidates: [] }), {
        updateStrategy: "appVersion",
      }).ok,
    ).toBe(true);
  });

  it("warns about, and imports, another app ID than the schemes name", () => {
    const other = checkNativeArtifact(info({}), {
      updateStrategy: "fingerprint",
      appIds: ["com.example.other"],
    });
    expect(other.ok).toBe(true);
    expect(other.warnings.map(({ code }) => code)).toEqual(["APP_ID_MISMATCH"]);
    expect(
      checkNativeArtifact(info({}), {
        updateStrategy: "fingerprint",
        appIds: ["com.example.other", "com.example.app"],
      }).warnings,
    ).toEqual([]);
  });

  it("registers under a channel it is given instead of the compiled-in one", () => {
    expect(
      checkNativeArtifact(
        info({
          channel: { unreadable: "The channel is a resource reference" },
        }),
        { updateStrategy: "fingerprint", channel: "beta-runtime" },
      ),
    ).toMatchObject({ ok: true, build: { channel: "beta-runtime" } });
    expect(
      codes(
        checkNativeArtifact(info({}), {
          updateStrategy: "fingerprint",
          channel: " padded ",
        }),
      ),
    ).toEqual(["INVALID_SCOPE"]);
  });

  it("names a simulator .app.zip an app", () => {
    expect(nativeArtifactKindOf("App.app.zip")).toBe("app");
    expect(nativeArtifactKindOf("App.zip")).toBeNull();
  });

  it("names every problem at once", () => {
    expect(
      codes(
        checkNativeArtifact(
          info({ builtInBundle: null, minBundleIdCandidates: [] }),
          { updateStrategy: "fingerprint" },
        ),
      ),
    ).toEqual(["NO_BUILT_IN_BUNDLE", "NO_MIN_BUNDLE_ID"]);
  });

  it("names the native build an artifact is already registered as", () => {
    expect(alreadyImportedProblem(MIN_BUNDLE_ID, "nb-1")).toEqual({
      code: "ALREADY_IMPORTED",
      nativeBuildId: "nb-1",
      message: expect.stringContaining("native build nb-1"),
    });
    expect(alreadyImportedProblem(MIN_BUNDLE_ID, null)).not.toHaveProperty(
      "nativeBuildId",
    );
  });
});

describe("the sandbox layer", () => {
  const sandboxApk = (overrides: Record<string, Uint8Array> = {}) =>
    apk({
      "AndroidManifest.xml": fixture("sandbox.axml"),
      "classes.dex": fixture("sandbox.dex"),
      ...overrides,
    });
  const sandboxIpa = (overrides: Record<string, Uint8Array> = {}) =>
    ipa({
      "Payload/App.app/Info.plist": fixture("Info.sandbox.plist"),
      "Payload/App.app/App": fixture("App-sandbox"),
      ...overrides,
    });

  it.each([
    ["apk", apk()],
    ["ipa", ipa()],
  ] as const)("finds none of it in a normal .%s", async (kind, files) => {
    const { sandbox } = await read(files, `app.${kind}`);
    expect(sandbox).toEqual({ code: false, declared: false });
  });

  it("finds it in an .apk, an .aab and an .ipa from the real toolchains", async () => {
    const whole = { code: true, declared: true };
    expect((await read(sandboxApk(), "app.apk")).sandbox).toEqual(whole);
    expect((await read(sandboxIpa(), "app.ipa")).sandbox).toEqual(whole);
    expect(
      (
        await read(
          aab({
            "base/manifest/AndroidManifest.xml": fixture("sandbox.pb"),
            "base/dex/classes.dex": fixture("sandbox.dex"),
          }),
          "app.aab",
        )
      ).sandbox,
    ).toEqual(whole);
  });

  it.each([
    ["only its code", { "AndroidManifest.xml": fixture("release.axml") }],
    ["only its manifest entry", { "classes.dex": fixture("classes.dex") }],
  ] as const)("refuses an .apk with %s", async (_, files) => {
    const checked = checkNativeArtifact(
      await read(sandboxApk(files), "app.apk"),
      { updateStrategy: "fingerprint", channel: "sandbox-release" },
    );
    expect(codes(checked)).toEqual(["SANDBOX_MISMATCH"]);
  });

  it("registers a sandbox build on its reserved channel, and a normal one elsewhere", async () => {
    expect(
      checkNativeArtifact(await read(sandboxApk(), "app.apk"), {
        updateStrategy: "fingerprint",
      }),
    ).toMatchObject({ ok: true, build: { channel: "sandbox-release" } });
    expect(
      checkNativeArtifact(await read(apk(), "app.apk"), {
        updateStrategy: "fingerprint",
      }),
    ).toMatchObject({ ok: true, build: { channel: "beta" } });
  });

  it("refuses a sandbox build on another channel, and a normal build on a reserved one", async () => {
    const onChannel = async (
      files: Record<string, Uint8Array | string>,
      channel: string,
    ) =>
      checkNativeArtifact(await read(files, "app.apk"), {
        updateStrategy: "fingerprint",
        channel,
      });
    expect(codes(await onChannel(sandboxApk(), "production"))).toEqual([
      "SANDBOX_MISMATCH",
    ]);
    expect(codes(await onChannel(apk(), "sandbox-release"))).toEqual([
      "SANDBOX_MISMATCH",
    ]);
  });

  it("says what is wrong and what to do, in a line each", () => {
    expect(
      sandboxArtifactProblem(
        info({ sandbox: { code: true, declared: true } }),
        "production",
      )?.message,
    ).toBe(
      "The .aab is a sandbox build, which can't register on channel production.\nUse a sandbox-<scheme> channel.",
    );
    expect(sandboxArtifactProblem(info({}), "sandbox-release")?.message).toBe(
      "Channel sandbox-release is reserved for sandbox builds, and the .aab isn't one.\nUse another channel, or build it with sandbox: true.",
    );
  });

  it("derives the reserved channel and a URL scheme any platform takes", () => {
    expect(sandboxChannelOf("release")).toBe("sandbox-release");
    expect(isSandboxChannel("sandbox-release")).toBe(true);
    expect(isSandboxChannel("sandboxes")).toBe(false);
    expect(isSandboxChannel("production")).toBe(false);
    expect(sandboxUrlSchemeOf("com.GronStudio.codex_relay")).toBe(
      "hu-sandbox-com-gronstudio-codex-relay",
    );
  });
});
