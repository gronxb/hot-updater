import fs from "fs";
import os from "os";
import path from "path";

import { extractBuiltInBundle as extractAndroid } from "@hot-updater/android-helper";
import { archiveAppBundle } from "@hot-updater/apple-helper";
import { loadConfig } from "@hot-updater/cli-tools";
import {
  createStorageAdapter,
  createStorageUri,
  parseStorageUri,
} from "@hot-updater/plugin-core";
import { NIL_UUID } from "@hot-updater/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabaseHarness } from "../../commands/database.testFixtures";
import { loadServer } from "../loadServer";
import { testServer } from "../testServer";
import type { NativeBuildResult } from "./createNativeBuild";
import {
  preflightNativeBuildRegistration,
  registerNativeBuild,
} from "./registerNativeBuild";

vi.mock("../loadServer", () => ({ loadServer: vi.fn() }));
vi.mock("../git", () => ({
  getLatestGitCommit: vi.fn(async () => ({ id: () => "abc123" })),
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
}));
vi.mock("@hot-updater/android-helper", () => ({
  extractBuiltInBundle: vi.fn(),
}));
vi.mock("@hot-updater/apple-helper", () => ({
  archiveAppBundle: vi.fn(),
  extractBuiltInBundle: vi.fn(),
}));

const harness = createDatabaseHarness();

/** Storage that keeps every object it is given, by key. */
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

const MIN_BUNDLE_ID = "019a0000-0000-7000-8000-020102030405";

const android = (
  overrides: Partial<NativeBuildResult> = {},
): NativeBuildResult =>
  ({
    platform: "android",
    scheme: "release",
    minBundleId: MIN_BUNDLE_ID,
    channel: "production",
    fingerprintHash: "fingerprint-a",
    appVersion: null,
    artifactPath: "",
    artifactKind: "apk",
    ...overrides,
  }) as NativeBuildResult;

describe("registerNativeBuild", () => {
  let dir: string;
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(async () => {
    vi.clearAllMocks();
    harness.reset();
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "register-"));
    storage = memoryStorage();
    vi.mocked(loadConfig).mockResolvedValue({} as never);
    vi.mocked(loadServer).mockImplementation(async () =>
      testServer({ database: harness.database, storage: storage.adapter }),
    );
    vi.mocked(extractAndroid).mockImplementation(async ({ outputPath }) => {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.promises.writeFile(outputPath, "built-in hermes bytecode");
    });
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("uploads the artifact and the built-in bundle, then registers both", async () => {
    const artifactPath = path.join(dir, "app-release.apk");
    await fs.promises.writeFile(artifactPath, "apk bytes");

    const buildKey = `nbk1:${"d".repeat(64)}`;
    const row = await registerNativeBuild(android({ artifactPath }), {
      buildKey,
    });

    expect(loadConfig).toHaveBeenCalledWith(null);

    expect(extractAndroid).toHaveBeenCalledWith({
      artifactPath,
      outputPath: expect.stringMatching(/index\.android\.bundle$/u),
    });
    expect(row).toMatchObject({
      platform: "android",
      fingerprint_hash: "fingerprint-a",
      min_bundle_id: MIN_BUNDLE_ID,
      artifact_kind: "apk",
      artifact_storage_uri: `mem://b/native-builds/android/${row.id}/app-release.apk`,
      byte_size: "apk bytes".length,
      git_commit_hash: "abc123",
      build_key: buildKey,
    });
    await expect(
      harness.core.findNativeBuild(
        {
          platform: "android",
          channel: "production",
          fingerprintHash: "fingerprint-a",
          appVersion: null,
        },
        { buildKey },
      ),
    ).resolves.toEqual(row);

    // The built-in bundle: a manifest listing only the JavaScript bundle at
    // an OTA bundle's asset path, and the file in the shared asset root.
    const manifest = JSON.parse(
      new TextDecoder().decode(
        storage.objects.get(`bundles/${MIN_BUNDLE_ID}/manifest.json`),
      ),
    );
    expect(manifest).toEqual({
      bundleId: MIN_BUNDLE_ID,
      assets: {
        "index.android.bundle": {
          byteSize: "built-in hermes bytecode".length,
          fileHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          downloadByteSize: expect.any(Number),
          downloadFileHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      },
    });
    const { downloadFileHash } = manifest.assets["index.android.bundle"];
    expect([...storage.objects.keys()].sort()).toEqual(
      [
        `assets/sha256/${downloadFileHash.slice(0, 2)}/${downloadFileHash}.br`,
        `bundles/${MIN_BUNDLE_ID}/manifest.json`,
        `native-builds/android/${row.id}/app-release.apk`,
      ].sort(),
    );
    await expect(harness.core.getBundle(MIN_BUNDLE_ID)).resolves.toMatchObject({
      bundle: {
        platform: "android",
        git_commit_hash: "abc123",
        manifest_storage_uri: `mem://b/bundles/${MIN_BUNDLE_ID}/manifest.json`,
        asset_base_storage_uri: "mem://b/assets",
      },
    });
    await expect(harness.core.countBundles()).resolves.toBe(0);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("stores a simulator .app as one zip archive", async () => {
    const { extractBuiltInBundle: extractIos } =
      await import("@hot-updater/apple-helper");
    vi.mocked(extractIos).mockImplementation(async ({ outputPath }) => {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.promises.writeFile(outputPath, "ios bytecode");
    });
    vi.mocked(archiveAppBundle).mockImplementation(async ({ outputPath }) => {
      await fs.promises.writeFile(outputPath, "zipped app");
    });

    const row = await registerNativeBuild(
      {
        ...android(),
        platform: "ios",
        fingerprintHash: null,
        appVersion: "1.2.0",
        artifactPath: path.join(dir, "App.app"),
        artifactKind: "app",
      },
      { buildKey: null },
    );

    expect(row).toMatchObject({
      platform: "ios",
      app_version: "1.2.0",
      artifact_kind: "app",
      artifact_storage_uri: `mem://b/native-builds/ios/${row.id}/App.app.zip`,
    });
    expect(
      storage.objects.get(`bundles/${MIN_BUNDLE_ID}/manifest.json`),
    ).toBeDefined();
    await expect(harness.core.getBundle(MIN_BUNDLE_ID)).resolves.toMatchObject({
      bundle: { metadata: { app_version: "1.2.0" } },
    });
  });

  it("refuses a debug build before it loads the config", async () => {
    await expect(
      registerNativeBuild(android({ minBundleId: NIL_UUID }), {
        buildKey: null,
      }),
    ).rejects.toThrow("A debug build has no built-in bundle");
    expect(loadServer).not.toHaveBeenCalled();
  });

  it("uploads nothing when the server cannot register native builds", async () => {
    vi.spyOn(harness.core, "findNativeBuild").mockRejectedValueOnce(
      new Error("The server has no native build route"),
    );

    await expect(
      registerNativeBuild(
        android({ artifactPath: path.join(dir, "app-release.apk") }),
        { buildKey: null },
      ),
    ).rejects.toThrow("no native build route");
    expect(storage.objects.size).toBe(0);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("deletes the artifact of a registration the database refuses", async () => {
    const artifactPath = path.join(dir, "app-release.apk");
    await fs.promises.writeFile(artifactPath, "apk bytes");
    vi.spyOn(harness.core, "registerNativeBuild").mockRejectedValueOnce(
      new Error("connection lost"),
    );

    await expect(
      registerNativeBuild(android({ artifactPath }), { buildKey: null }),
    ).rejects.toThrow("connection lost");
    // The built-in bundle's files stay for `storage prune`.
    expect(
      [...storage.objects.keys()].filter((key) =>
        key.startsWith("native-builds/"),
      ),
    ).toEqual([]);
    expect(storage.objects.has(`bundles/${MIN_BUNDLE_ID}/manifest.json`)).toBe(
      true,
    );
  });

  it("deletes its artifact when another registration of the same built-in bundle wins", async () => {
    const artifactPath = path.join(dir, "app-release.apk");
    await fs.promises.writeFile(artifactPath, "apk bytes");
    const register = harness.core.registerNativeBuild;
    vi.spyOn(harness.core, "registerNativeBuild").mockImplementationOnce(
      async (registration) => {
        // Another import of the same artifact writes first.
        await register({
          ...registration,
          id: "01ff0000-0000-7000-8000-000000000002",
          artifact: { ...registration.artifact, storageUri: "mem://b/other" },
        });
        return register(registration);
      },
    );

    await expect(
      registerNativeBuild(android({ artifactPath }), { buildKey: null }),
    ).rejects.toThrow();
    expect(
      [...storage.objects.keys()].filter((key) =>
        key.startsWith("native-builds/"),
      ),
    ).toEqual([]);
  });

  it("keeps the artifact of a registration that committed although its write failed", async () => {
    const artifactPath = path.join(dir, "app-release.apk");
    await fs.promises.writeFile(artifactPath, "apk bytes");
    const register = harness.core.registerNativeBuild;
    vi.spyOn(harness.core, "registerNativeBuild").mockImplementationOnce(
      async (registration) => {
        await register(registration);
        // Another build of the scope lands before the CLI checks its own.
        await register({
          ...registration,
          id: "01ff0000-0000-7000-8000-000000000001",
          minBundleId: "019b0000-0000-7000-8000-020000000001",
        });
        throw new Error("response lost");
      },
    );

    await expect(
      registerNativeBuild(android({ artifactPath }), { buildKey: null }),
    ).rejects.toThrow("response lost");
    const ours = (await harness.core.listNativeBuilds({ limit: 10 })).find(
      ({ min_bundle_id }) => min_bundle_id === MIN_BUNDLE_ID,
    );
    expect(
      storage.objects.has(`native-builds/android/${ours!.id}/app-release.apk`),
    ).toBe(true);
  });
});

describe("preflightNativeBuildRegistration", () => {
  let dir: string;
  let storage: ReturnType<typeof memoryStorage>;
  const scope = {
    platform: "android",
    channel: "production",
    fingerprintHash: "fingerprint-a",
    appVersion: null,
  } as const;

  beforeEach(async () => {
    vi.clearAllMocks();
    harness.reset();
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "preflight-"));
    storage = memoryStorage();
    vi.mocked(loadConfig).mockResolvedValue({} as never);
    vi.mocked(loadServer).mockImplementation(async () =>
      testServer({ database: harness.database, storage: storage.adapter }),
    );
    vi.mocked(extractAndroid).mockImplementation(async ({ outputPath }) => {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.promises.writeFile(outputPath, "built-in hermes bytecode");
    });
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("asks the registry, and writes nothing, when it tracks no build yet", async () => {
    const exists = vi.spyOn(storage.adapter, "exists");
    const put = vi.spyOn(storage.adapter, "put");

    await preflightNativeBuildRegistration(scope);

    expect(exists).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(storage.objects.size).toBe(0);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("reads back the tracked build's artifact, at the storage location the server wrote it to", async () => {
    const artifactPath = path.join(dir, "app-release.apk");
    await fs.promises.writeFile(artifactPath, "apk bytes");
    const row = await registerNativeBuild(android({ artifactPath }), {
      buildKey: null,
    });
    const exists = vi.spyOn(storage.adapter, "exists");
    const put = vi.spyOn(storage.adapter, "put");

    await preflightNativeBuildRegistration(scope);

    expect(exists).toHaveBeenCalledWith({
      storageUri: row.artifact_storage_uri,
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("without a scope, as before a prebuild generates the native projects, reads back the registry's newest build", async () => {
    const artifactPath = path.join(dir, "app-release.apk");
    await fs.promises.writeFile(artifactPath, "apk bytes");
    // Another scope's build: a scope-free check still reaches it.
    const row = await registerNativeBuild(
      android({ artifactPath, fingerprintHash: "fingerprint-b" }),
      { buildKey: null },
    );
    const exists = vi.spyOn(storage.adapter, "exists");
    const find = vi.spyOn(harness.core, "findNativeBuild");
    // Only the preflight's own reads: the registration above found too.
    find.mockClear();

    await preflightNativeBuildRegistration(null);

    expect(find).not.toHaveBeenCalled();
    expect(exists).toHaveBeenCalledWith({
      storageUri: row.artifact_storage_uri,
    });
  });

  it("without a scope and with nothing tracked, reads the registry and probes nothing", async () => {
    const exists = vi.spyOn(storage.adapter, "exists");

    await preflightNativeBuildRegistration(null);

    expect(exists).not.toHaveBeenCalled();
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("fails when the server has no registry", async () => {
    vi.spyOn(harness.core, "findNativeBuild").mockRejectedValueOnce(
      new Error("The server has no native build route"),
    );

    await expect(preflightNativeBuildRegistration(scope)).rejects.toThrow(
      "its native build registry: The server has no native build route",
    );
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("fails when the storage can't read the tracked build back", async () => {
    const artifactPath = path.join(dir, "app-release.apk");
    await fs.promises.writeFile(artifactPath, "apk bytes");
    await registerNativeBuild(android({ artifactPath }), { buildKey: null });
    vi.spyOn(storage.adapter, "exists").mockRejectedValueOnce(
      new Error("AccessDenied"),
    );

    await expect(preflightNativeBuildRegistration(scope)).rejects.toThrow(
      "its memoryStorage storage: AccessDenied",
    );
  });

  it("fails before any read when the storage can't store", async () => {
    vi.mocked(loadServer).mockImplementation(async () =>
      testServer({
        database: harness.database,
        storage: createStorageAdapter({ name: "readOnly", protocol: "mem" }),
      }),
    );
    const find = vi.spyOn(harness.core, "findNativeBuild");

    await expect(preflightNativeBuildRegistration(scope)).rejects.toThrow(
      "its readOnly storage: the storage adapter does not implement put.",
    );
    expect(find).not.toHaveBeenCalled();
  });
});
