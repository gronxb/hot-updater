import crypto from "crypto";
import fs from "fs/promises";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { brotliDecompressSync } from "zlib";

import type {
  BuildAdapter,
  StorageAdapterWith,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Manifest } from "../utils/bundleManifest";
import * as fileHash from "../utils/getFileHash";
import { testServer } from "../utils/testServer";
import { createDatabaseHarness } from "./database.testFixtures";
import { deploy } from "./deploy";

const { getCwd, loadConfig } = vi.hoisted(() => ({
  getCwd: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    getCwd,
    loadConfig,
    loadPlatformConfigs: async (
      platforms: readonly string[],
      { channel }: { channel: string },
    ) =>
      Promise.all(
        platforms.map(async (platform) => ({
          platform,
          config: await loadConfig({ channel, platform }),
        })),
      ),
    p: {
      ...actual.p,
      isCancel: () => false,
      log: Object.fromEntries(
        Object.keys(actual.p.log).map((key) => [key, vi.fn()]),
      ),
      note: vi.fn(),
      outro: vi.fn(),
      tasks: async (tasks: { task: () => Promise<unknown> }[]) => {
        for (const task of tasks) await task.task();
      },
    },
  };
});

vi.mock("@/utils/git", () => ({
  appendToProjectRootGitignore: () => false,
  getLatestGitCommit: async () => null,
}));
vi.mock("@/utils/createBundleDiff", () => import("../utils/createBundleDiff"));
vi.mock("@/utils/bundleManifest", () => import("../utils/bundleManifest"));
vi.mock(
  "@/utils/getBundleZipTargets",
  () => import("../utils/getBundleZipTargets"),
);
vi.mock("@/utils/getFileHash", () => import("../utils/getFileHash"));
vi.mock("@/signedHashUtils", () => import("../signedHashUtils"));
vi.mock("@/prompts/getPlatform", () => ({ getPlatform: vi.fn() }));
vi.mock("@/utils/fingerprint", () => ({
  appendFingerprintExtraSources: (sources: unknown) => sources,
}));
vi.mock("@/utils/fingerprint/diff", () => ({}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/version/getDefaultTargetAppVersion", () => ({
  getDefaultTargetAppVersion: async () => null,
}));
vi.mock("@/utils/version/getNativeAppVersion", () => ({
  getNativeAppVersion: async () => null,
}));
vi.mock("@/utils/signing/validateSigningConfig", () => ({
  validateSigningConfig: async () => ({ issues: [] }),
}));

vi.mock("@/utils/loadServer", async () => ({
  ...(await vi.importActual<typeof import("../utils/loadServer")>(
    "../utils/loadServer",
  )),
  loadServer: async (config: {
    database: Parameters<typeof testServer>[0]["database"];
    storage: Parameters<typeof testServer>[0]["storage"];
  }) => testServer(config),
}));

// Inspect real CLI archives using its existing ZIP/TAR dependencies. This fixture
// exercises packaging opaque bytes; it is not native compiler or device evidence.
const cliRequire = createRequire(
  import.meta.resolve("@hot-updater/cli-tools/package.json"),
);
const tar = cliRequire("tar") as {
  extract(options: { file: string; cwd: string; gzip: boolean }): Promise<void>;
};
const sha256 = (bytes: Buffer) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const bundleId = "01900000-0000-7000-8000-000000000123";
const options = {
  channel: "production",
  forceUpdate: false,
  interactive: false,
  platform: "ios" as const,
  targetAppVersion: "1.0.x",
};

describe("deploy archive artifact declarations", () => {
  const database = createDatabaseHarness();
  const uploads = new Map<string, Buffer>();
  const storage: StorageAdapterWith<"put" | "get" | "exists" | "delete"> = {
    name: "archive-test-storage",
    protocol: "s3",
    put: vi.fn(async ({ key, body }) => {
      uploads.set(key, Buffer.from(await new Response(body).arrayBuffer()));
      return { storageUri: `s3://test-bucket/${key}` };
    }),
    get: vi.fn(),
    exists: vi.fn(async () => ({ exists: false })),
    delete: vi.fn(),
  };
  let directory: string;
  let buildPath: string;
  let build: BuildAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    database.reset();
    uploads.clear();
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "deploy-archive-")),
    );
    buildPath = path.join(directory, "build");
    await fs.mkdir(buildPath);
    getCwd.mockReturnValue(directory);
    const declareOpaqueArtifacts = async () => {
      const artifacts = [];
      for (const name of await fs.readdir(buildPath, { recursive: true })) {
        const filePath = path.join(buildPath, name);
        if ((await fs.lstat(filePath)).isFile()) {
          artifacts.push({
            path: filePath,
            name: name.split(path.sep).join("/"),
            downloadCompression: null,
          });
        }
      }
      return artifacts;
    };
    build = {
      name: "opaque-output",
      build: async () => ({
        artifacts: await declareOpaqueArtifacts(),
        buildPath,
        bundleId,
        patchAssetPath: "entry.bundle",
        stdout: null,
      }),
    };
    loadConfig.mockImplementation(async () => ({
      build: async () => build,
      database: database.database,
      fingerprint: {},
      patch: { enabled: false },
      storage,
      updateStrategy: "appVersion",
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const writeFiles = async (files: Record<string, Buffer>) => {
    for (const [name, bytes] of Object.entries(files)) {
      const destination = path.join(buildPath, name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes);
    }
  };

  const readArchive = async (
    extension: string,
  ): Promise<Record<string, Buffer>> => {
    const uploaded = [...uploads].find(([key]) =>
      key.endsWith(`/bundle.${extension}`),
    )?.[1];
    expect(uploaded).toBeDefined();
    const archivePath = path.join(directory, "download.tar");
    await fs.writeFile(
      archivePath,
      extension === "tar.br" ? brotliDecompressSync(uploaded!) : uploaded!,
    );
    const extracted = path.join(directory, "extracted");
    await fs.mkdir(extracted);
    await tar.extract({
      file: archivePath,
      cwd: extracted,
      gzip: extension === "tar.gz",
    });
    const result: Record<string, Buffer> = {};
    for (const name of await fs.readdir(extracted, { recursive: true })) {
      const file = path.join(extracted, name);
      if ((await fs.stat(file)).isFile())
        result[name.split(path.sep).join("/")] = await fs.readFile(file);
    }
    return result;
  };

  it("uploads a manifest-authenticated tar.br containing all declared opaque bytes", async () => {
    const files = Object.fromEntries(
      [
        "entry.bundle",
        "entry.bundle.hbc",
        "entry.bundle.map",
        "async/bootstrap.bundle",
        "assets/runtime.map",
        "assets/image.png",
        "hot-updater-lynx.json",
      ].map((name, index) => [
        name,
        Buffer.from([0, 255, index, ...Buffer.from(name)]),
      ]),
    );
    await writeFiles(files);

    await deploy(options);

    const archive = await readArchive("tar.br");
    expect(Object.keys(archive).sort()).toEqual(Object.keys(files).sort());
    const manifestBytes = [...uploads].find(([key]) =>
      key.endsWith("/manifest.json"),
    )![1];
    const manifest = JSON.parse(manifestBytes.toString()) as Manifest;
    expect(manifest.bundleId).toBe(bundleId);
    expect(Object.keys(manifest.assets).sort()).toEqual(
      Object.keys(files).sort(),
    );
    for (const [name, bytes] of Object.entries(files)) {
      expect(archive[name]).toEqual(bytes);
      expect(manifest.assets[name]?.fileHash).toBe(sha256(bytes));
      expect(await fs.readFile(path.join(buildPath, name))).toEqual(bytes);
    }
    expect(archive).not.toHaveProperty("manifest.json");
    const stored = (await database.bundles())[0]!;
    expect(stored.manifestFileHash).toBe(sha256(manifestBytes));
    expect(stored.metadata?.manifest_content_hash).toBe(sha256(manifestBytes));
    expect(manifest.archive?.downloadFileHash).toBe(
      sha256([...uploads].find(([key]) => key.endsWith("/bundle.tar.br"))![1]),
    );
  });

  it("honors RN-owned Hermes selection declarations", async () => {
    const files = {
      "index.bundle": Buffer.from("javascript"),
      "index.bundle.hbc": Buffer.from("hermes"),
      "index.bundle.map": Buffer.from("source map"),
    };
    await writeFiles(files);
    build.build = async () => ({
      artifacts: [
        {
          path: path.join(buildPath, "index.bundle.hbc"),
          name: "index.bundle",
          downloadCompression: "br",
        },
      ],
      buildPath,
      bundleId,
      patchAssetPath: "index.bundle",
      stdout: null,
    });
    await deploy(options);
    const archive = await readArchive("tar.br");
    expect(Object.keys(archive)).toEqual(["index.bundle"]);
    expect(archive["index.bundle"]).toEqual(files["index.bundle.hbc"]);
  });

  it("preserves the previous successful CLI archive when the next compiler run fails", async () => {
    await writeFiles({
      "entry.bundle": Buffer.from("previous successful output"),
    });
    await deploy(options);
    const archivePath = path.join(
      directory,
      ".hot-updater/output/bundle.tar.br",
    );
    const previousArchive = await fs.readFile(archivePath);
    uploads.clear();
    vi.mocked(storage.put).mockClear();
    database.deploy.mockClear();
    build.build = async () => {
      throw new Error("Compiler failed");
    };

    await expect(deploy(options)).rejects.toThrow("Compiler failed");

    expect(await fs.readFile(archivePath)).toEqual(previousArchive);
    expect(storage.put).not.toHaveBeenCalled();
    expect(database.deploy).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Compiler failed" }),
    );
  });

  it("removes the attempt snapshot before propagating a database failure", async () => {
    await writeFiles({
      "entry.bundle": Buffer.from("snapshot cleanup"),
    });
    database.deploy.mockRejectedValueOnce(new Error("commit failed"));

    await expect(deploy(options)).rejects.toThrow("commit failed");

    expect(
      (await fs.readdir(buildPath)).filter((name) =>
        name.startsWith(".hot-updater-snapshot-"),
      ),
    ).toEqual([]);
  });

  it.each(["file", "directory", "symlink", "case-alias"])(
    "rejects a manifest %s before hashing or uploading",
    async (kind) => {
      const reserved = path.join(
        buildPath,
        kind === "case-alias" ? "MANIFEST.JSON" : "manifest.json",
      );
      if (kind === "directory") await fs.mkdir(reserved);
      else if (kind === "symlink")
        await fs.symlink(path.join(directory, "missing"), reserved, "file");
      else await fs.writeFile(reserved, "compiler manifest");
      await fs.writeFile(path.join(buildPath, "entry.bundle"), "entry");
      const hash = vi.spyOn(fileHash, "getFileHashFromFile");
      await expect(deploy(options)).rejects.toThrow(
        "Build output contains reserved manifest.json",
      );
      expect(console.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Build output contains reserved manifest.json",
        }),
      );
      expect(hash).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(database.deploy).not.toHaveBeenCalled();
      if (kind === "file" || kind === "case-alias")
        expect(await fs.readFile(reserved, "utf8")).toBe("compiler manifest");
    },
  );
});
