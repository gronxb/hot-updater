import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

import { hdiff } from "@hot-updater/bsdiff";
import {
  createStorageAdapter,
  createStorageUri,
  createUUIDv7,
  parseStorageUri,
} from "@hot-updater/plugin-core";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleDiff } from "../utils/createBundleDiff";
import { testServer } from "../utils/testServer";
import { createDatabaseHarness } from "./database.testFixtures";
import { handleNativeBuildImport } from "./nativeBuildImport";

const { loadConfig, loadServer, log } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  loadServer: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig,
  p: { log },
}));
vi.mock("../utils/loadServer", () => ({ loadServer }));
vi.mock("@/utils/loadServer", () => ({ loadServer }));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("../utils/git", () => ({
  getLatestGitCommit: vi.fn(async () => ({ id: () => "this-checkout" })),
}));
// hdiff takes Hermes bytecode; its inputs are what this checks.
vi.mock("@hot-updater/bsdiff", () => ({
  hdiff: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
}));

// Built by __fixtures__/generate.sh in @hot-updater/protocol with javac, d8,
// aapt2, clang and plutil; these are the values it compiled in.
const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../protocol/src/nativeArtifact/__fixtures__",
);
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
const MIN_BUNDLE_ID = "019a2b3c-4d5e-7000-8000-000000000000";
const FINGERPRINT =
  "5de1cdbfefdc1f0b4a1b3c36ed83c246dff317dd540c0393ca76fa758026ec8f";

const BUILT_IN = Buffer.from(
  `${"console.log('the built-in bundle');\n".repeat(64)}`,
);

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const harness = createDatabaseHarness();

/** Storage that keeps every object it is given, by key, and serves it back. */
const memoryStorage = () => {
  const objects = new Map<string, Uint8Array>();
  const keyOf = (storageUri: string) => parseStorageUri(storageUri, "mem").key;
  return {
    objects,
    adapter: createStorageAdapter({
      name: "memoryStorage",
      protocol: "mem",
      async put({ key, body }) {
        objects.set(
          key,
          new Uint8Array(await new Response(body).arrayBuffer()),
        );
        return {
          storageUri: createStorageUri({ protocol: "mem", bucket: "b", key }),
        };
      },
      async get({ storageUri }) {
        const bytes = objects.get(keyOf(storageUri));
        return {
          response: bytes === undefined ? null : new Response(bytes.slice()),
        };
      },
      async exists({ storageUri }) {
        return { exists: objects.has(keyOf(storageUri)) };
      },
      async delete({ storageUri }) {
        objects.delete(keyOf(storageUri));
        return { deleted: true };
      },
    }),
  };
};

const writeArtifact = async (
  dir: string,
  name: string,
  files: Record<string, Uint8Array | string>,
) => {
  const archive = new JSZip();
  for (const [entry, content] of Object.entries(files)) {
    archive.file(entry, content);
  }
  const file = path.join(dir, name);
  await fs.promises.writeFile(
    file,
    await archive.generateAsync({ type: "uint8array" }),
  );
  return file;
};

const aab = (overrides: Record<string, Uint8Array | string> = {}) => ({
  "base/manifest/AndroidManifest.xml": fixture("release.pb"),
  "base/dex/classes.dex": fixture("classes.dex"),
  "base/assets/index.android.bundle": BUILT_IN,
  ...overrides,
});

const config = (overrides: Record<string, unknown> = {}) => ({
  updateStrategy: "fingerprint",
  nativeBuild: { ios: {}, android: {} },
  ...overrides,
});

/** The JSON the command printed on the last line of its output. */
const printedJson = (spy: ReturnType<typeof vi.spyOn>) =>
  JSON.parse(String(spy.mock.calls.at(-1)?.[0]));

describe("native-build import", () => {
  let dir: string;
  let storage: ReturnType<typeof memoryStorage>;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    harness.reset();
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nb-import-"));
    storage = memoryStorage();
    loadConfig.mockResolvedValue(config());
    loadServer.mockImplementation(async () =>
      testServer({ database: harness.database, storage: storage.adapter }),
    );
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    stdout.mockRestore();
    process.exitCode = undefined;
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("uploads an .aab and its built-in bundle, and registers it by what it compiled in", async () => {
    const file = await writeArtifact(dir, "app-release.aab", aab());

    await handleNativeBuildImport(file, { json: true });

    expect(process.exitCode).toBeUndefined();
    const { nativeBuild } = printedJson(stdout);
    expect(nativeBuild).toMatchObject({
      platform: "android",
      fingerprint_hash: FINGERPRINT,
      app_version: null,
      min_bundle_id: MIN_BUNDLE_ID,
      artifact_kind: "aab",
      byte_size: fs.statSync(file).size,
      // Built elsewhere: no commit of this checkout, and no build key.
      git_commit_hash: null,
      build_key: null,
    });
    await expect(
      harness.core.findNativeBuild({
        platform: "android",
        channel: "beta",
        fingerprintHash: FINGERPRINT,
        appVersion: null,
      }),
    ).resolves.toEqual(nativeBuild);

    // The artifact byte for byte, and the built-in bundle as deploy stores
    // a JavaScript bundle.
    expect(
      Buffer.compare(
        storage.objects.get(
          `native-builds/android/${nativeBuild.id}/app-release.aab`,
        )!,
        fs.readFileSync(file),
      ),
    ).toBe(0);
    const manifest = JSON.parse(
      new TextDecoder().decode(
        storage.objects.get(
          `bundles/${MIN_BUNDLE_ID}/${nativeBuild.id}/manifest.json`,
        ),
      ),
    );
    const asset = manifest.assets["index.android.bundle"];
    expect(asset).toMatchObject({
      byteSize: BUILT_IN.byteLength,
      fileHash: sha256(BUILT_IN),
    });
    const stored = storage.objects.get(
      `assets/sha256/${asset.downloadFileHash.slice(0, 2)}/${asset.downloadFileHash}.br`,
    )!;
    expect(Buffer.compare(brotliDecompressSync(stored), BUILT_IN)).toBe(0);
  });

  it("imports an .ipa by its app version under the appVersion strategy", async () => {
    loadConfig.mockResolvedValue(config({ updateStrategy: "appVersion" }));
    const file = await writeArtifact(dir, "App.ipa", {
      "Payload/App.app/Info.plist": fixture("Info.plist"),
      "Payload/App.app/App": fixture("App"),
      "Payload/App.app/main.jsbundle": BUILT_IN,
    });

    await handleNativeBuildImport(file, { json: true });

    expect(printedJson(stdout).nativeBuild).toMatchObject({
      platform: "ios",
      fingerprint_hash: null,
      app_version: "1.4.0",
      min_bundle_id: MIN_BUNDLE_ID,
      artifact_kind: "ipa",
    });
    await expect(
      harness.core.findNativeBuild({
        platform: "ios",
        channel: "beta & gamma",
        fingerprintHash: null,
        appVersion: "1.4.0",
      }),
    ).resolves.toMatchObject({ min_bundle_id: MIN_BUNDLE_ID });
  });

  it.each([
    [
      "an .aab",
      "app-release.aab",
      "android",
      (bytes: (name: string) => Buffer) =>
        aab({ "base/dex/classes.dex": bytes("classes.dex") }),
    ],
    [
      "an .ipa",
      "App.ipa",
      "ios",
      (bytes: (name: string) => Buffer) => ({
        "Payload/App.app/Info.plist": fixture("Info.plist"),
        "Payload/App.app/App": bytes("App"),
        "Payload/App.app/main.jsbundle": BUILT_IN,
      }),
    ],
  ] as const)(
    "imports %s an earlier CLI built, whose MIN_BUNDLE_ID has a platform byte and random bits",
    async (_kind, name, platform, files) => {
      // Apps in the field carry the MIN_BUNDLE_ID an earlier `native-build`
      // issued: any UUIDv7 is one.
      const earlier = `019a2b3c-4d5e-7000-8000-${platform === "ios" ? "01" : "02"}a1b2c3d4e5`;
      /** The fixture with `earlier` compiled in instead. */
      const withEarlier = (fixtureName: string) => {
        const bytes = Buffer.from(fixture(fixtureName));
        const at = bytes.indexOf(MIN_BUNDLE_ID);
        expect(at).toBeGreaterThan(-1);
        bytes.write(earlier, at, "ascii");
        return bytes;
      };
      if (platform === "ios") {
        loadConfig.mockResolvedValue(config({ updateStrategy: "appVersion" }));
      }
      const file = await writeArtifact(dir, name, files(withEarlier));

      await handleNativeBuildImport(file, { json: true });

      expect(process.exitCode).toBeUndefined();
      expect(printedJson(stdout).nativeBuild).toMatchObject({
        platform,
        min_bundle_id: earlier,
      });
      await expect(harness.core.getBundle(earlier)).resolves.not.toBeNull();
    },
  );

  it("imports a debuggable release build, whose SDK still reports its built-in bundle", async () => {
    // A release variant made debuggable compiles the SDK's release code,
    // as the E2E builds do; a debug variant packs no bundle to import.
    const file = await writeArtifact(
      dir,
      "app-release.aab",
      aab({ "base/manifest/AndroidManifest.xml": fixture("debuggable.pb") }),
    );

    await handleNativeBuildImport(file, { json: true });

    expect(process.exitCode).toBeUndefined();
    expect(printedJson(stdout).nativeBuild).toMatchObject({
      min_bundle_id: MIN_BUNDLE_ID,
    });
  });

  it("reads and checks with --dry-run, and records nothing", async () => {
    const file = await writeArtifact(dir, "app-release.aab", aab());

    await handleNativeBuildImport(file, { json: true, dryRun: true });

    expect(printedJson(stdout)).toMatchObject({
      ok: true,
      dryRun: true,
      build: { minBundleId: MIN_BUNDLE_ID, channel: "beta" },
      nativeBuild: null,
    });
    expect(storage.objects.size).toBe(0);
    await expect(harness.core.getBundle(MIN_BUNDLE_ID)).resolves.toBeNull();
  });

  it("imports the same build again as a success that changes nothing, as a rerun CI job does", async () => {
    const file = await writeArtifact(dir, "app-release.aab", aab());
    await handleNativeBuildImport(file, { json: true });
    const first = printedJson(stdout).nativeBuild;
    const stored = [...storage.objects.keys()];
    stdout.mockClear();

    await handleNativeBuildImport(file, { json: true });

    expect(process.exitCode).toBeUndefined();
    expect(printedJson(stdout)).toMatchObject({
      ok: true,
      alreadyImported: true,
      nativeBuild: { id: first.id, min_bundle_id: MIN_BUNDLE_ID },
    });
    expect([...storage.objects.keys()]).toEqual(stored);
    await expect(
      harness.core.listNativeBuilds({ limit: 10 }),
    ).resolves.toHaveLength(1);
  });

  // The fixtures' generate.sh writes CFBundleVersion 42 and versionCode 42.
  it("records the build number an .ipa reports, its CFBundleVersion", async () => {
    loadConfig.mockResolvedValue(config({ updateStrategy: "appVersion" }));
    const file = await writeArtifact(dir, "App.ipa", {
      "Payload/App.app/Info.plist": fixture("Info.plist"),
      "Payload/App.app/App": fixture("App"),
      "Payload/App.app/main.jsbundle": BUILT_IN,
    });

    await handleNativeBuildImport(file, { json: true });

    const { nativeBuild } = printedJson(stdout);
    await expect(
      harness.core.getNativeBuild(nativeBuild.id),
    ).resolves.toMatchObject({ artifact_kind: "ipa", build_number: "42" });
  });

  it("records the build number an .apk reports, its versionCode", async () => {
    const file = await writeArtifact(dir, "app-release.apk", {
      "AndroidManifest.xml": fixture("release.axml"),
      "classes.dex": fixture("classes.dex"),
      "assets/index.android.bundle": BUILT_IN,
    });

    await handleNativeBuildImport(file, { json: true });

    expect(process.exitCode).toBeUndefined();
    const { nativeBuild } = printedJson(stdout);
    await expect(
      harness.core.getNativeBuild(nativeBuild.id),
    ).resolves.toMatchObject({ artifact_kind: "apk", build_number: "42" });
  });

  it("leaves the stored row as it was when the same build is imported again", async () => {
    const file = await writeArtifact(dir, "app-release.aab", aab());
    await handleNativeBuildImport(file, { json: true });
    const { nativeBuild } = printedJson(stdout);
    const before = await harness.core.getNativeBuild(nativeBuild.id);
    stdout.mockClear();

    await handleNativeBuildImport(file, { json: true });

    expect(printedJson(stdout)).toMatchObject({ alreadyImported: true });
    expect(before).toMatchObject({ build_number: "42" });
    await expect(harness.core.getNativeBuild(nativeBuild.id)).resolves.toEqual(
      before,
    );
  });

  it("refuses another artifact whose MIN_BUNDLE_ID is registered, naming the build, and uploads nothing", async () => {
    await handleNativeBuildImport(
      await writeArtifact(dir, "app-release.aab", aab()),
      { json: true },
    );
    const first = printedJson(stdout).nativeBuild;
    const stored = [...storage.objects.keys()];
    for (const [files, options] of [
      // Other JavaScript under the same ID.
      [
        aab({ "base/assets/index.android.bundle": "console.log('other');" }),
        {},
      ],
      // The same build on another channel.
      [aab(), { channel: "staging" }],
    ] as const) {
      stdout.mockClear();
      process.exitCode = undefined;
      await handleNativeBuildImport(
        await writeArtifact(dir, "other.aab", files),
        { json: true, ...options },
      );

      expect(process.exitCode).toBe(1);
      expect(printedJson(stdout).problems).toEqual([
        {
          code: "ALREADY_IMPORTED",
          nativeBuildId: first.id,
          message: expect.stringContaining(`native build ${first.id}`),
        },
      ]);
    }
    expect([...storage.objects.keys()]).toEqual(stored);
  });

  it("finds the same build when it is not its scope's newest", async () => {
    const file = await writeArtifact(dir, "app-release.aab", aab());
    await handleNativeBuildImport(file, { json: true });
    const first = printedJson(stdout).nativeBuild;
    // A newer build of the same scope.
    await harness.core.registerNativeBuild({
      id: createUUIDv7(),
      minBundleId: createUUIDv7(),
      platform: "android",
      channel: "beta",
      fingerprintHash: FINGERPRINT,
      appVersion: null,
      gitCommitHash: null,
      buildKey: null,
      artifact: { kind: "aab", storageUri: "mem://b/x.aab", byteSize: 1 },
      embeddedBundle: {
        manifestStorageUri: "mem://b/m.json",
        manifestFileHash: "h",
        assetBaseStorageUri: "mem://b/assets",
      },
    });
    stdout.mockClear();

    await handleNativeBuildImport(file, { json: true });

    expect(printedJson(stdout)).toMatchObject({
      ok: true,
      alreadyImported: true,
      nativeBuild: { id: first.id },
    });
  });

  it("settles a race with another import of the same build as already imported, deleting its own upload", async () => {
    // Each server gets its own config: disposing one closes its database.
    loadConfig.mockImplementation(async () => config());
    const file = await writeArtifact(dir, "app-release.aab", aab());
    const register = harness.core.registerNativeBuild;
    let winner: string | undefined;
    vi.spyOn(harness.core, "registerNativeBuild").mockImplementationOnce(
      async (registration) => {
        // The winner uploaded its own manifest, under its own ID.
        const id = createUUIDv7();
        const own = parseStorageUri(
          registration.embeddedBundle.manifestStorageUri,
          "mem",
        ).key;
        const winnerKey = `bundles/${MIN_BUNDLE_ID}/${id}/manifest.json`;
        storage.objects.set(winnerKey, storage.objects.get(own)!);
        winner = (
          await register({
            ...registration,
            id,
            artifact: { ...registration.artifact, storageUri: "mem://b/w" },
            embeddedBundle: {
              ...registration.embeddedBundle,
              manifestStorageUri: `mem://b/${winnerKey}`,
            },
          })
        ).id;
        return register(registration);
      },
    );

    await handleNativeBuildImport(file, { json: true });

    expect(process.exitCode).toBeUndefined();
    expect(printedJson(stdout)).toMatchObject({
      ok: true,
      alreadyImported: true,
      nativeBuild: { id: winner },
    });
    // The losing upload's artifact is deleted.
    expect(
      [...storage.objects.keys()].filter((key) =>
        key.startsWith("native-builds/"),
      ),
    ).toEqual([]);
    // No lookup reuses the database of a server disposed before it.
    const configs = loadServer.mock.calls.map(([loaded]) => loaded);
    expect(configs.length).toBeGreaterThanOrEqual(3);
    expect(new Set(configs).size).toBe(configs.length);
  });

  it("keeps the registered build's manifest when an import of another built-in bundle with its MIN_BUNDLE_ID races it", async () => {
    loadConfig.mockImplementation(async () => config());
    const winner = await writeArtifact(dir, "winner.aab", aab());
    const loser = await writeArtifact(
      dir,
      "loser.aab",
      aab({ "base/assets/index.android.bundle": "console.log('other');" }),
    );
    // Both pass the check; the winner registers after the loser's check and
    // before its uploads, at the registry lookup that precedes them.
    const find = harness.core.findNativeBuild;
    let winnerRow: { id: string; min_bundle_id: string } | undefined;
    vi.spyOn(harness.core, "findNativeBuild").mockImplementationOnce(
      async (...args) => {
        await handleNativeBuildImport(winner, { json: true });
        winnerRow = printedJson(stdout).nativeBuild;
        stdout.mockClear();
        return find(...args);
      },
    );

    await handleNativeBuildImport(loser, { json: true });

    expect(process.exitCode).toBe(1);
    expect(printedJson(stdout).problems).toEqual([
      expect.objectContaining({
        code: "ALREADY_IMPORTED",
        nativeBuildId: winnerRow!.id,
      }),
    ]);
    // The registered manifest still lists the winner's bundle, whose hash
    // the row records, so its patches still verify.
    const detail = await harness.core.getBundle(MIN_BUNDLE_ID);
    const manifestKey = parseStorageUri(
      detail!.bundle.manifest_storage_uri,
      "mem",
    ).key;
    const manifestBytes = storage.objects.get(manifestKey)!;
    expect(sha256(manifestBytes)).toBe(detail!.bundle.manifest_file_hash);
    expect(
      JSON.parse(new TextDecoder().decode(manifestBytes)).assets[
        "index.android.bundle"
      ].fileHash,
    ).toBe(sha256(BUILT_IN));
    // Nothing of the loser's stays but the shared asset store.
    expect(
      [...storage.objects.keys()].filter(
        (key) => key.startsWith("native-builds/") || key.startsWith("bundles/"),
      ),
    ).toEqual([
      expect.stringContaining(winnerRow!.id),
      expect.stringContaining(winnerRow!.id),
    ]);
  });

  it("registers under the channel --channel names, which the app reports at runtime", async () => {
    const file = await writeArtifact(dir, "app-release.aab", aab());

    await handleNativeBuildImport(file, {
      json: true,
      channel: "e2e-native-build-019a2b3c4d5e",
    });

    expect(printedJson(stdout).build).toMatchObject({
      channel: "e2e-native-build-019a2b3c4d5e",
    });
    await expect(
      harness.core.findNativeBuild({
        platform: "android",
        channel: "e2e-native-build-019a2b3c4d5e",
        fingerprintHash: FINGERPRINT,
        appVersion: null,
      }),
    ).resolves.toMatchObject({ min_bundle_id: MIN_BUNDLE_ID });
  });

  it("imports a simulator .app.zip, the .app at its root, as an app artifact", async () => {
    loadConfig.mockResolvedValue(config({ updateStrategy: "appVersion" }));
    const file = await writeArtifact(dir, "App.app.zip", {
      "App.app/Info.plist": fixture("Info.plist"),
      "App.app/App": fixture("App"),
      "App.app/main.jsbundle": BUILT_IN,
    });

    await handleNativeBuildImport(file, { json: true });

    const { nativeBuild } = printedJson(stdout);
    expect(nativeBuild).toMatchObject({
      platform: "ios",
      artifact_kind: "app",
      min_bundle_id: MIN_BUNDLE_ID,
      app_version: "1.4.0",
    });
    // Stored as given, not archived again.
    expect(
      Buffer.compare(
        storage.objects.get(`native-builds/ios/${nativeBuild.id}/App.app.zip`)!,
        fs.readFileSync(file),
      ),
    ).toBe(0);
  });

  it.skipIf(process.platform !== "darwin")(
    "imports a simulator .app directory, archived as ditto archives it",
    async () => {
      loadConfig.mockResolvedValue(config({ updateStrategy: "appVersion" }));
      const app = path.join(dir, "App.app");
      await fs.promises.mkdir(app);
      await fs.promises.writeFile(
        path.join(app, "Info.plist"),
        fixture("Info.plist"),
      );
      await fs.promises.writeFile(path.join(app, "App"), fixture("App"));
      await fs.promises.writeFile(path.join(app, "main.jsbundle"), BUILT_IN);

      await handleNativeBuildImport(app, { json: true });

      const { nativeBuild } = printedJson(stdout);
      expect(nativeBuild).toMatchObject({
        artifact_kind: "app",
        min_bundle_id: MIN_BUNDLE_ID,
      });
      const zip = await JSZip.loadAsync(
        storage.objects.get(`native-builds/ios/${nativeBuild.id}/App.app.zip`)!,
      );
      expect(
        Buffer.compare(
          Buffer.from(
            await zip.file("App.app/main.jsbundle")!.async("uint8array"),
          ),
          BUILT_IN,
        ),
      ).toBe(0);
    },
  );

  it.each([
    [
      "a build without a built-in bundle",
      (() => {
        const files: Record<string, Uint8Array | string> = aab();
        delete files["base/assets/index.android.bundle"];
        return files;
      })(),
      ["NO_BUILT_IN_BUNDLE"],
    ],
    [
      "a build without Hot Updater's build step",
      aab({ "base/dex/classes.dex": fixture("plain.dex") }),
      ["NO_MIN_BUNDLE_ID", "NO_FINGERPRINT"],
    ],
    [
      "a build whose code holds two UUIDv7 strings",
      aab({ "base/dex/classes2.dex": fixture("other.dex") }),
      ["AMBIGUOUS_MIN_BUNDLE_ID"],
    ],
    [
      "a build whose channel is a resource reference",
      aab({ "base/manifest/AndroidManifest.xml": fixture("reference.pb") }),
      ["INVALID_SCOPE"],
    ],
  ])("refuses %s before reaching the server", async (_, files, codes) => {
    const file = await writeArtifact(dir, "app.aab", files);

    await handleNativeBuildImport(file, { json: true });

    expect(process.exitCode).toBe(1);
    expect(
      printedJson(stdout).problems.map(({ code }: { code: string }) => code),
    ).toEqual(codes);
    expect(loadServer).not.toHaveBeenCalled();
  });

  it("warns about another app ID than the schemes name, and imports it", async () => {
    loadConfig.mockResolvedValue(
      config({
        nativeBuild: {
          ios: {},
          android: {
            // The application ID defaults to the package name.
            release: { packageName: "com.other" },
          },
        },
      }),
    );
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = await writeArtifact(dir, "app.aab", aab());

    await handleNativeBuildImport(file, { json: true });

    expect(process.exitCode).toBeUndefined();
    expect(printedJson(stdout)).toMatchObject({
      ok: true,
      warnings: [{ code: "APP_ID_MISMATCH" }],
    });
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("com.example.app"),
    );
    stderr.mockRestore();
  });

  it("makes the imported built-in bundle the base an OTA deployed after it patches from", async () => {
    const file = await writeArtifact(dir, "app-release.aab", aab());
    await handleNativeBuildImport(file, { json: true });

    // An OTA of the same scope, deployed after the import, as deploy stores it.
    const ota = Buffer.concat([BUILT_IN, Buffer.from("console.log(2);\n")]);
    const otaId = createUUIDv7();
    const compressed = brotliCompressSync(ota);
    const downloadFileHash = sha256(compressed);
    storage.objects.set(
      `assets/sha256/${downloadFileHash.slice(0, 2)}/${downloadFileHash}.br`,
      compressed,
    );
    const manifestText = JSON.stringify({
      bundleId: otaId,
      assets: {
        "index.android.bundle": {
          byteSize: ota.byteLength,
          fileHash: sha256(ota),
          downloadByteSize: compressed.byteLength,
          downloadFileHash,
        },
      },
    });
    storage.objects.set(
      `bundles/${otaId}/manifest.json`,
      new TextEncoder().encode(manifestText),
    );
    await harness.core.deploy([
      {
        bundle: {
          id: otaId,
          platform: "android",
          gitCommitHash: null,
          metadata: {},
          manifestStorageUri: `mem://b/bundles/${otaId}/manifest.json`,
          manifestFileHash: sha256(manifestText),
          assetBaseStorageUri: "mem://b/assets",
        },
        release: {
          channel: "beta",
          enabled: true,
          fingerprintHash: FINGERPRINT,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: null,
        },
      },
    ]);

    // Deploy's built-in base: the registry's newest build of the OTA's scope.
    const base = await harness.core.findNativeBuild({
      platform: "android",
      channel: "beta",
      fingerprintHash: FINGERPRINT,
      appVersion: null,
    });
    expect(base?.min_bundle_id).toBe(MIN_BUNDLE_ID);
    await createBundleDiff(
      { baseBundleId: base!.min_bundle_id, bundleId: otaId },
      { core: harness.core, storageAdapter: storage.adapter },
    );

    // The patch diffs the artifact's own JavaScript bundle into the OTA's.
    expect(vi.mocked(hdiff)).toHaveBeenCalledOnce();
    const [baseBytes, targetBytes] = vi.mocked(hdiff).mock.calls[0]!;
    const bytesOf = (bytes: ArrayBufferLike | ArrayBufferView) =>
      ArrayBuffer.isView(bytes)
        ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : Buffer.from(bytes);
    expect(Buffer.compare(bytesOf(baseBytes), BUILT_IN)).toBe(0);
    expect(Buffer.compare(bytesOf(targetBytes), ota)).toBe(0);
    const detail = await harness.core.getBundle(otaId);
    expect(detail?.patches).toEqual([
      expect.objectContaining({ base_bundle_id: MIN_BUNDLE_ID }),
    ]);
  });
});
