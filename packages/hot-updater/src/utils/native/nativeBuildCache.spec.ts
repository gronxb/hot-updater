import fs from "fs";
import os from "os";
import path from "path";

import { loadConfig } from "@hot-updater/cli-tools";
import {
  createStorageAdapter,
  createStorageUri,
  type NativeBuildRegistration,
  parseStorageUri,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabaseHarness } from "../../commands/database.testFixtures";
import { loadServer } from "../loadServer";
import { testServer } from "../testServer";
import type { NativeBuildKeyComponents } from "./buildKey";
import type { NativeBuildResult } from "./createNativeBuild";
import {
  findCachedNativeBuild,
  markCachedNativeBuildTracked,
  nativeBuildCacheSlot,
  readCachedNativeBuild,
  saveCachedNativeBuild,
} from "./nativeBuildCache";

vi.mock("../loadServer", () => ({ loadServer: vi.fn() }));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
}));

const harness = createDatabaseHarness();

/** Storage that keeps every object it is given, by key, and reads them back. */
const memoryStorage = () => {
  const objects = new Map<string, Uint8Array>();
  const keyOf = (storageUri: string) => parseStorageUri(storageUri, "mem").key;
  const adapter = createStorageAdapter({
    name: "memoryStorage",
    protocol: "mem",
    async put({ key, body }) {
      objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
      return {
        storageUri: createStorageUri({ protocol: "mem", bucket: "b", key }),
      };
    },
    async get({ storageUri }) {
      const object = objects.get(keyOf(storageUri));
      return { response: object ? new Response(object as BodyInit) : null };
    },
    async exists({ storageUri }) {
      return { exists: objects.has(keyOf(storageUri)) };
    },
  });
  return { objects, adapter };
};

const KEY = `nbk1:${"1".repeat(64)}`;
const OTHER_KEY = `nbk1:${"2".repeat(64)}`;
const MIN_BUNDLE_ID = "019a0000-0000-7000-8000-020102030405";
const BUILD_ID = "019a0000-0000-7000-8000-0000000000b1";

const components = (
  files: Record<string, string> = { "src/App.tsx": "a" },
): NativeBuildKeyComponents => ({
  engine: "hot-updater/native-build@2",
  files,
  inputs: {},
  autolinking: {},
  settings: { channel: "production" },
  signing: {},
  toolchain: {},
  env: {},
});

const scope = {
  platform: "android",
  channel: "production",
  fingerprintHash: null,
  appVersion: "1.0.0",
} as const;

describe("the native build cache", () => {
  let dir: string;
  let slot: string;
  let outputPath: string;
  let storage: ReturnType<typeof memoryStorage>;

  /** A build of `name` in `outputPath`, as createNativeBuild leaves it. */
  const built = async (
    contents = "apk bytes",
    minBundleId = MIN_BUNDLE_ID,
  ): Promise<NativeBuildResult> => {
    await fs.promises.rm(outputPath, { recursive: true, force: true });
    await fs.promises.mkdir(path.join(outputPath, "release"), {
      recursive: true,
    });
    const artifactPath = path.join(outputPath, "release", "app-release.apk");
    await fs.promises.writeFile(artifactPath, contents);
    await fs.promises.writeFile(path.join(outputPath, "mapping.txt"), "map");
    return {
      platform: "android",
      scheme: "release",
      minBundleId,
      channel: "production",
      fingerprintHash: null,
      appVersion: "1.0.0",
      artifactPath,
      artifactKind: "apk",
    };
  };

  /** Tracks a build with `buildKey`, its artifact in storage. */
  const track = async (buildKey: string | null, contents = "stored apk") => {
    const { storageUri } = await storage.adapter.put!({
      key: `native-builds/android/${BUILD_ID}/app-release.apk`,
      body: new Response(contents).body!,
      contentType: "application/octet-stream",
    });
    const registration: NativeBuildRegistration = {
      ...scope,
      id: BUILD_ID,
      minBundleId: MIN_BUNDLE_ID,
      gitCommitHash: null,
      buildKey,
      artifact: { kind: "apk", storageUri, byteSize: contents.length },
      embeddedBundle: {
        manifestStorageUri: `mem://b/bundles/${MIN_BUNDLE_ID}/manifest.json`,
        manifestFileHash: "hash",
        assetBaseStorageUri: "mem://b/assets",
      },
    };
    return harness.core.registerNativeBuild(registration);
  };

  const find = (key = KEY, slotDir: string | null = slot) =>
    findCachedNativeBuild({
      key,
      scheme: "release",
      slot: slotDir,
      predictedScope: scope,
      outputPath,
    });

  beforeEach(async () => {
    vi.clearAllMocks();
    harness.reset();
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nb-cache-"));
    slot = nativeBuildCacheSlot(path.join(dir, "cache"), "android", "release");
    outputPath = path.join(dir, "out");
    storage = memoryStorage();
    vi.mocked(loadConfig).mockResolvedValue({} as never);
    vi.mocked(loadServer).mockImplementation(async () =>
      testServer({ database: harness.database, storage: storage.adapter }),
    );
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("keeps one build per platform and scheme, replacing it whole", async () => {
    const first = await built("first");
    await saveCachedNativeBuild({
      slot,
      key: KEY,
      components: components(),
      build: first,
      outputPath,
      nativeBuildId: null,
    });
    const second = await built("second");
    await saveCachedNativeBuild({
      slot,
      key: OTHER_KEY,
      components: components({ "src/App.tsx": "b" }),
      build: second,
      outputPath,
      nativeBuildId: null,
    });

    const cached = await readCachedNativeBuild(slot);
    expect(cached).toMatchObject({
      key: OTHER_KEY,
      build: { ...second, artifactPath: "release/app-release.apk" },
      nativeBuildId: null,
    });
    // Only the entry: no staging directory or old entry is left behind.
    expect(await fs.promises.readdir(slot)).toEqual(["entry"]);
    expect(
      await fs.promises.readFile(
        path.join(slot, "entry", "artifact", "release", "app-release.apk"),
        "utf8",
      ),
    ).toBe("second");

    // A save that fails leaves the entry it would have replaced.
    await expect(
      saveCachedNativeBuild({
        slot,
        key: KEY,
        components: components(),
        build: first,
        outputPath: path.join(dir, "missing"),
        nativeBuildId: null,
      }),
    ).rejects.toThrow();
    expect((await readCachedNativeBuild(slot))?.key).toBe(OTHER_KEY);
    expect(await fs.promises.readdir(slot)).toEqual(["entry"]);

    await markCachedNativeBuildTracked(slot, OTHER_KEY, BUILD_ID);
    expect((await readCachedNativeBuild(slot))?.nativeBuildId).toBe(BUILD_ID);
  });

  it("reuses this machine's build of a dry run, with its MIN_BUNDLE_ID, when no tracked build has the key", async () => {
    await saveCachedNativeBuild({
      slot,
      key: KEY,
      components: components(),
      build: await built("dry run apk"),
      outputPath,
      nativeBuildId: null,
    });
    await fs.promises.rm(outputPath, { recursive: true });

    const { hit } = await find();

    expect(hit).toMatchObject({
      source: "local",
      nativeBuildId: null,
      result: {
        minBundleId: MIN_BUNDLE_ID,
        artifactPath: path.join(outputPath, "release", "app-release.apk"),
      },
    });
    expect(
      await fs.promises.readFile(
        path.join(outputPath, "release", "app-release.apk"),
        "utf8",
      ),
    ).toBe("dry run apk");
    // The build's other output comes back with it.
    expect(
      await fs.promises.readFile(path.join(outputPath, "mapping.txt"), "utf8"),
    ).toBe("map");
    // Another key reuses nothing.
    expect((await find(OTHER_KEY)).hit).toBeNull();
  });

  it("reuses a tracked build with the key from storage, in one registry read, without building or uploading", async () => {
    const row = await track(KEY);
    const put = vi.spyOn(storage.adapter, "put");
    const get = vi.spyOn(storage.adapter, "get");
    const findNativeBuild = vi.spyOn(harness.core, "findNativeBuild");
    harness.read.mockClear();

    const { hit } = await find(KEY, null);

    expect(hit).toEqual({
      source: "storage",
      nativeBuild: row,
      result: {
        platform: "android",
        scheme: "release",
        minBundleId: MIN_BUNDLE_ID,
        channel: "production",
        fingerprintHash: null,
        appVersion: "1.0.0",
        artifactPath: path.join(outputPath, "app-release.apk"),
        artifactKind: "apk",
      },
    });
    expect(await fs.promises.readFile(hit!.result.artifactPath, "utf8")).toBe(
      "stored apk",
    );
    expect(findNativeBuild).toHaveBeenCalledExactlyOnceWith(scope, {
      buildKey: KEY,
    });
    expect(harness.read).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  it("copies a tracked build from this machine when its slot holds it", async () => {
    await track(KEY);
    await saveCachedNativeBuild({
      slot,
      key: KEY,
      components: components(),
      build: await built("local apk"),
      outputPath,
      nativeBuildId: BUILD_ID,
    });
    const get = vi.spyOn(storage.adapter, "get");

    const { hit } = await find();

    expect(hit?.source).toBe("storage");
    expect(get).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(hit!.result.artifactPath, "utf8")).toBe(
      "local apk",
    );
  });

  it("reuses nothing for a tracked build whose artifact storage lost, not even this machine's copy", async () => {
    const row = await track(KEY);
    storage.objects.clear();
    await saveCachedNativeBuild({
      slot,
      key: KEY,
      components: components(),
      build: await built(),
      outputPath,
      nativeBuildId: BUILD_ID,
    });

    await expect(find()).resolves.toMatchObject({
      hit: null,
      missingArtifact: row,
    });
  });

  it("never reuses a build registered without a key, or one an older server answers without it", async () => {
    await track(null);
    expect((await find(KEY, null)).hit).toBeNull();

    // A server that ignores `buildKey` answers the scope's newest build.
    vi.spyOn(harness.core, "findNativeBuild").mockResolvedValueOnce({
      ...(await harness.core.findNativeBuild(scope))!,
      build_key: undefined as never,
    });
    expect((await find(KEY, null)).hit).toBeNull();
  });
});
