// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConfigResponse } from "@hot-updater/cli-tools";
import type { Bundle, StoragePlugin } from "@hot-updater/plugin-core";
import JSZip from "jszip";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCopiedBundleArchive,
  LEGACY_BUNDLE_ERROR,
} from "./promoteBundle";

const baseBundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "stable",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "abc123",
  storageUri: "https://example.com/bundle.zip",
  gitCommitHash: "deadbeef",
  message: "Initial message",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: [],
};

const config = {
  signing: {
    enabled: false,
  },
} as ConfigResponse;

async function createZipArchive(
  archivePath: string,
  files: Record<string, string>,
) {
  const zip = new JSZip();

  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }

  await fs.writeFile(
    archivePath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}

async function createTarGzArchive(
  archivePath: string,
  files: Record<string, string>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promote-tar-gz-"));

  try {
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(dir, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    }

    const entries = await fs.readdir(dir);
    entries.sort((left, right) => left.localeCompare(right));

    await tar.create(
      {
        file: archivePath,
        cwd: dir,
        gzip: true,
      },
      entries,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createTarBrArchive(
  archivePath: string,
  files: Record<string, string>,
) {
  const { brotliCompressSync } = await import("node:zlib");
  const tarPath = archivePath.replace(/\.br$/, "");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promote-tar-br-"));

  try {
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(dir, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    }

    const entries = await fs.readdir(dir);
    entries.sort((left, right) => left.localeCompare(right));

    await tar.create(
      {
        file: tarPath,
        cwd: dir,
        gzip: false,
      },
      entries,
    );

    await fs.writeFile(
      archivePath,
      brotliCompressSync(await fs.readFile(tarPath)),
    );
  } finally {
    await fs.rm(tarPath, { force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readZipManifest(archivePath: string) {
  const zip = await JSZip.loadAsync(await fs.readFile(archivePath));
  const manifest = zip.file("manifest.json");
  if (!manifest) {
    throw new Error("manifest.json not found");
  }

  return JSON.parse(await manifest.async("text")) as { bundleId: string };
}

async function readTarManifest(archivePath: string, gzip: boolean) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promote-read-tar-"));

  try {
    await tar.extract({
      file: archivePath,
      cwd: dir,
      gzip,
      strict: true,
    });

    return JSON.parse(
      await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
    ) as { bundleId: string };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readTarBrManifest(archivePath: string) {
  const { brotliDecompressSync } = await import("node:zlib");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promote-read-br-"));
  const tarPath = path.join(dir, "bundle.tar");

  try {
    await fs.writeFile(
      tarPath,
      brotliDecompressSync(await fs.readFile(archivePath)),
    );
    await tar.extract({
      file: tarPath,
      cwd: dir,
      gzip: false,
      strict: true,
    });

    return JSON.parse(
      await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
    ) as { bundleId: string };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createSourceArchive(
  format: "zip" | "tar.gz" | "tar.br",
  files: Record<string, string>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promote-source-"));
  const archivePath = path.join(dir, `bundle.${format}`);

  switch (format) {
    case "zip":
      await createZipArchive(archivePath, files);
      break;
    case "tar.gz":
      await createTarGzArchive(archivePath, files);
      break;
    case "tar.br":
      await createTarBrArchive(archivePath, files);
      break;
  }

  return {
    archivePath,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createCopiedBundleArchive", () => {
  it.each([
    ["zip", readZipManifest],
    ["tar.gz", (archivePath: string) => readTarManifest(archivePath, true)],
    ["tar.br", readTarBrManifest],
  ] as const)(
    "rewrites manifest.json and uploads a %s archive",
    async (format, readManifest) => {
      const { archivePath, cleanup } = await createSourceArchive(format, {
        "index.js": "console.log('hello');",
        "manifest.json": JSON.stringify({
          bundleId: baseBundle.id,
          assets: {
            "index.js": {
              fileHash: "asset-hash",
            },
          },
        }),
      });
      const uploadedFiles = new Map<string, string>();
      const storagePlugin: StoragePlugin = {
        name: "mockStorage",
        supportedProtocol: "s3",
        delete: vi.fn(),
        getDownloadUrl: vi.fn(),
        upload: vi.fn(async (key, filePath) => {
          const uploadPath = path.join(
            path.dirname(archivePath),
            `${key}.${format}`,
          );
          await fs.copyFile(filePath, uploadPath);
          uploadedFiles.set(key, uploadPath);
          return {
            storageUri: `s3://bucket/${path.basename(uploadPath)}`,
          };
        }),
      };

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(await fs.readFile(archivePath));
        }),
      );

      try {
        const copiedBundle = await createCopiedBundleArchive({
          bundle: {
            ...baseBundle,
            storageUri: `https://example.com/bundle.${format}`,
          },
          config,
          nextBundleId: "bundle-copy-id",
          storagePlugin,
          targetChannel: "beta",
        });

        expect(copiedBundle.id).toBe("bundle-copy-id");
        expect(copiedBundle.channel).toBe("beta");
        expect(copiedBundle.storageUri).toBe(
          `s3://bucket/bundle-copy-id.${format}`,
        );
        expect(copiedBundle.fileHash).not.toBe(baseBundle.fileHash);

        const uploadedArchivePath = uploadedFiles.get("bundle-copy-id");
        expect(uploadedArchivePath).toBeDefined();

        const manifest = await readManifest(uploadedArchivePath as string);
        expect(manifest.bundleId).toBe("bundle-copy-id");
      } finally {
        await cleanup();
      }
    },
  );

  it("throws a legacy bundle error when manifest.json is missing", async () => {
    const { archivePath, cleanup } = await createSourceArchive("zip", {
      "index.js": "console.log('hello');",
    });
    const storagePlugin: StoragePlugin = {
      name: "mockStorage",
      supportedProtocol: "s3",
      delete: vi.fn(),
      getDownloadUrl: vi.fn(),
      upload: vi.fn(),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(await fs.readFile(archivePath));
      }),
    );

    try {
      await expect(
        createCopiedBundleArchive({
          bundle: baseBundle,
          config,
          nextBundleId: "bundle-copy-id",
          storagePlugin,
          targetChannel: "beta",
        }),
      ).rejects.toThrow(LEGACY_BUNDLE_ERROR);
    } finally {
      await cleanup();
    }
  });
});
