import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

import type {
  HotUpdaterCoreApi,
  StorageAdapterWith,
} from "@hot-updater/plugin-core";

import { BUILT_IN_MIN_BUNDLE_ID_PATTERN } from "../built-in-bundle-id.ts";
import { importPublished } from "../published.ts";

const {
  createBundleStorageKey,
  createStorageRootUriWithPath,
  createUUIDv7,
  getManifestAssetDownloadPath,
  getManifestAssetStoragePath,
} = await importPublished<typeof import("@hot-updater/plugin-core")>(
  "@hot-updater/plugin-core",
);
const { putStorageFile } = await importPublished<
  typeof import("@hot-updater/cli-tools")
>("@hot-updater/cli-tools");
const { extractBuiltInBundle: extractAndroidBuiltInBundle } =
  await importPublished<typeof import("@hot-updater/android-helper")>(
    "@hot-updater/android-helper",
  );
const { archiveAppBundle, extractBuiltInBundle: extractIosBuiltInBundle } =
  await importPublished<typeof import("@hot-updater/apple-helper")>(
    "@hot-updater/apple-helper",
  );

const execFileAsync = promisify(execFile);

type Platform = "ios" | "android";

/** Where `hot-updater native-build ios|android` stores a native build's artifact. */
const NATIVE_BUILD_STORAGE_PREFIX = "native-builds";

/** The channel prefix the controller's proxy and deploys leave unnamespaced. */
export const NATIVE_BUILD_CHANNEL_PREFIX = "e2e-native-build-";

/**
 * The channel an E2E app binary registers under: its own. One registration
 * then serves every run of that binary, whose bytes are the same, and the
 * newest registration of another binary never shadows it. It is named by the
 * ID's build time, the part the built-in suffix leaves unique, which keeps
 * it short to type on the device.
 */
export const nativeBuildChannel = (minBundleId: string): string =>
  `${NATIVE_BUILD_CHANNEL_PREFIX}${minBundleId.slice(0, 13).replace("-", "")}`;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const isMachO = async (file: string): Promise<boolean> => {
  const handle = await fs.open(file, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    if (bytesRead < 4) return false;
    const magic = buffer.readUInt32BE(0);
    // 64-bit and 32-bit Mach-O in either byte order, and universal binaries.
    return [
      0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe,
    ].includes(magic);
  } finally {
    await handle.close();
  }
};

/**
 * The MIN_BUNDLE_ID an E2E build compiled in, read from its code: the
 * dex files of an `.apk` or an `.aab`, or the `.app`'s Mach-O files. A
 * cached binary carries no other record of it.
 */
export async function readArtifactMinBundleId(
  artifactPath: string,
  platform: Platform,
): Promise<string> {
  const ids = new Set<string>();
  const collect = (bytes: Buffer) => {
    for (const match of bytes
      .toString("latin1")
      .matchAll(new RegExp(BUILT_IN_MIN_BUNDLE_ID_PATTERN.source, "g"))) {
      ids.add(match[0]);
    }
  };
  if (platform === "android") {
    const { stdout } = await execFileAsync(
      "unzip",
      [
        "-p",
        artifactPath,
        path.extname(artifactPath) === ".aab"
          ? "base/dex/classes*.dex"
          : "classes*.dex",
      ],
      { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 },
    );
    collect(stdout);
  } else {
    const entries = await fs.readdir(artifactPath, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (await isMachO(file)) collect(await fs.readFile(file));
    }
  }
  if (ids.size !== 1) {
    throw new Error(
      `Expected one MIN_BUNDLE_ID compiled into ${artifactPath}, found ${ids.size}: ${[...ids].join(", ") || "none"}.`,
    );
  }
  return [...ids][0]!;
}

/** The built-in bundle's manifest and its one file, as registration stores them. */
async function prepareBuiltInBundle({
  minBundleId,
  platform,
  artifactPath,
  workDir,
}: {
  minBundleId: string;
  platform: Platform;
  artifactPath: string;
  workDir: string;
}) {
  const assetPath = `index.${platform}.bundle`;
  const bundlePath = path.join(workDir, "bundle", assetPath);
  await (
    platform === "android"
      ? extractAndroidBuiltInBundle
      : extractIosBuiltInBundle
  )({ artifactPath, outputPath: bundlePath });
  const bytes = await fs.readFile(bundlePath);
  const fileHash = sha256(bytes);
  // Stored as deploy stores a JavaScript bundle: Brotli at quality 11.
  const downloadPath = getManifestAssetDownloadPath(assetPath);
  const download =
    downloadPath === assetPath
      ? bytes
      : brotliCompressSync(bytes, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
        });
  const downloadFileHash = download === bytes ? undefined : sha256(download);
  const storagePath = getManifestAssetStoragePath({
    assetPath: downloadPath,
    downloadFileHash,
    fileHash,
  });
  const uploadPath = path.join(
    workDir,
    "upload",
    path.posix.basename(storagePath),
  );
  await fs.mkdir(path.dirname(uploadPath), { recursive: true });
  await fs.writeFile(uploadPath, download);
  const manifest = {
    bundleId: minBundleId,
    assets: {
      [assetPath]: {
        byteSize: bytes.byteLength,
        fileHash,
        downloadByteSize: download.byteLength,
        ...(downloadFileHash ? { downloadFileHash } : {}),
      },
    },
  };
  const manifestPath = path.join(workDir, "manifest", "manifest.json");
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(manifestPath, manifestText);
  return {
    fileHash,
    manifestPath,
    manifestFileHash: sha256(Buffer.from(manifestText)),
    storagePath,
    uploadPath,
  };
}

/**
 * Refuses an app whose dependencies really live outside the checkout that
 * builds its OTA. React Native names an asset by its real path relative to
 * the project, so a dependency reached through a symlink into another
 * checkout, such as a node_modules shared from the one that built the
 * native app, gives the OTA asset paths the native build never packaged,
 * and its built-in assets are downloaded instead of reused.
 */
export async function assertDependenciesInCheckout({
  checkoutDir,
  projectDir,
}: {
  checkoutDir: string;
  projectDir: string;
}): Promise<void> {
  const checkout = await fs.realpath(checkoutDir);
  const dependency = await fs.realpath(
    path.join(projectDir, "node_modules/react-native"),
  );
  if (!dependency.startsWith(`${checkout}${path.sep}`)) {
    throw new Error(
      `${projectDir} resolves react-native to ${dependency}, outside the checkout ${checkout}. Install the checkout's own dependencies: React Native names assets by their real paths, so the OTA's would not match the native build's.`,
    );
  }
}

export type InstalledNativeBuild = {
  readonly minBundleId: string;
  readonly channel: string;
  /** The SHA-256 of the built-in bundle's file in the binary. */
  readonly builtInFileHash: string;
  /** False when an earlier run registered this binary. */
  readonly registered: boolean;
};

/**
 * Registers the E2E app binary the run installs, as `hot-updater
 * native-build ios|android` tracks a build: its artifact under `native-builds/`, and
 * its built-in bundle, taken byte for byte from it with the build helpers'
 * extractors, as a bundle no release publishes. An ID registers once, so a
 * binary an earlier run registered is checked, not registered again.
 */
export async function registerInstalledNativeBuild({
  core,
  storage,
  platform,
  artifactPath,
  appVersion,
}: {
  core: Pick<
    HotUpdaterCoreApi,
    "findNativeBuild" | "getBundle" | "registerNativeBuild"
  >;
  storage: StorageAdapterWith<"put">;
  platform: Platform;
  artifactPath: string;
  appVersion: string;
}): Promise<InstalledNativeBuild> {
  const minBundleId = await readArtifactMinBundleId(artifactPath, platform);
  const channel = nativeBuildChannel(minBundleId);
  const scope = {
    platform,
    channel,
    fingerprintHash: null,
    appVersion,
  } as const;
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hu-e2e-native-build-"),
  );
  try {
    const prepared = await prepareBuiltInBundle({
      minBundleId,
      platform,
      artifactPath,
      workDir,
    });
    const checkRegistered = async (): Promise<boolean> => {
      const detail = await core.getBundle(minBundleId);
      if (detail === null) return false;
      // The same ID is the same binary, so its built-in bundle is the same.
      if (
        detail.bundle.platform !== platform ||
        detail.bundle.manifest_file_hash !== prepared.manifestFileHash
      ) {
        throw new Error(
          `Built-in bundle ${minBundleId} is registered with other bytes than ${artifactPath} carries.`,
        );
      }
      const nativeBuild = await core.findNativeBuild(scope);
      if (nativeBuild?.min_bundle_id !== minBundleId) {
        throw new Error(
          `Built-in bundle ${minBundleId} is registered outside ${channel} for app version ${appVersion}.`,
        );
      }
      return true;
    };
    if (await checkRegistered()) {
      return {
        minBundleId,
        channel,
        builtInFileHash: prepared.fileHash,
        registered: false,
      };
    }

    const id = createUUIDv7();
    const manifestUpload = await putStorageFile(
      storage,
      createBundleStorageKey(minBundleId),
      prepared.manifestPath,
    );
    const assetBaseStorageUri = createStorageRootUriWithPath(
      manifestUpload.storageUri,
      minBundleId,
      "assets",
    );
    // `assets/` is shared and content-addressed, as deploy uploads it.
    const assetKey = ["assets", path.posix.dirname(prepared.storagePath)]
      .filter((segment) => segment !== ".")
      .join("/");
    await putStorageFile(storage, assetKey, prepared.uploadPath);
    // A simulator `.app` is a directory: it is stored as one zip archive.
    const artifactFile =
      platform === "ios"
        ? path.join(workDir, `${path.basename(artifactPath)}.zip`)
        : artifactPath;
    if (platform === "ios") {
      await archiveAppBundle({
        appPath: artifactPath,
        outputPath: artifactFile,
      });
    }
    const artifactUpload = await putStorageFile(
      storage,
      [NATIVE_BUILD_STORAGE_PREFIX, platform, id].join("/"),
      artifactFile,
    );
    try {
      await core.registerNativeBuild({
        ...scope,
        id,
        minBundleId,
        gitCommitHash: null,
        buildKey: null,
        artifact: {
          kind:
            platform === "ios"
              ? "app"
              : path.extname(artifactPath) === ".aab"
                ? "aab"
                : "apk",
          storageUri: artifactUpload.storageUri,
          byteSize: artifactUpload.byteSize,
        },
        embeddedBundle: {
          manifestStorageUri: manifestUpload.storageUri,
          manifestFileHash: prepared.manifestFileHash,
          assetBaseStorageUri,
          metadata: { app_version: appVersion },
        },
      });
    } catch (error) {
      // Another run of the same binary may have registered it first.
      if (!(await checkRegistered())) throw error;
      return {
        minBundleId,
        channel,
        builtInFileHash: prepared.fileHash,
        registered: false,
      };
    }
    return {
      minBundleId,
      channel,
      builtInFileHash: prepared.fileHash,
      registered: true,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
