import fs from "fs";
import os from "os";
import path from "path";

import { extractBuiltInBundle as extractAndroidBuiltInBundle } from "@hot-updater/android-helper";
import {
  archiveAppBundle,
  extractBuiltInBundle as extractIosBuiltInBundle,
} from "@hot-updater/apple-helper";
import { loadConfig, p, putStorageFile } from "@hot-updater/cli-tools";
import {
  assertStorageOperations,
  createBundleStorageKey,
  createStorageRootUriWithPath,
  createUUIDv7,
  type NativeBuildRow,
} from "@hot-updater/plugin-core";
import { NIL_UUID } from "@hot-updater/protocol";

import {
  createBundleManifest,
  writeBundleManifestFile,
} from "../bundleManifest";
import { ui } from "../cli-ui";
import {
  MANIFEST_ASSET_UPLOAD_CONCURRENCY,
  prepareContentAddressedAssetUploadTargets,
  runWithConcurrency,
  uploadContentAddressedAsset,
} from "../contentAddressedAssets";
import { getFileHashFromFile } from "../getFileHash";
import { getLatestGitCommit } from "../git";
import { loadServer } from "../loadServer";
import type { NativeBuildResult } from "./createNativeBuild";

/** Where a native build's artifact is stored, under the config's storage. */
export const NATIVE_BUILD_STORAGE_PREFIX = "native-builds";

/**
 * Registers a release build in the native build registry, with the
 * credentials deploy uses: the config's database and storage. It uploads the
 * artifact under `native-builds/<platform>/<id>/`, and the built-in bundle,
 * taken byte for byte from the artifact, as a bundle whose manifest lists
 * only its JavaScript bundle file, at the path an OTA bundle's manifest
 * gives it. No release publishes that bundle.
 */
export const registerNativeBuild = async (
  build: NativeBuildResult,
): Promise<NativeBuildRow> => {
  if (build.minBundleId === NIL_UUID) {
    throw new Error(
      "A debug build has no built-in bundle to register: it loads its JavaScript from Metro. Build a release variant or configuration to register it.",
    );
  }
  const server = await loadServer(await loadConfig(null));
  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-native-build-"),
  );
  try {
    const { core, storage } = server;
    assertStorageOperations(storage, ["put", "exists"]);
    const scope =
      build.fingerprintHash === null
        ? {
            platform: build.platform,
            channel: build.channel,
            fingerprintHash: null,
            appVersion: build.appVersion,
          }
        : {
            platform: build.platform,
            channel: build.channel,
            fingerprintHash: build.fingerprintHash,
            appVersion: null,
          };
    // A server without the registry refuses here, before any upload.
    await core.findNativeBuild(scope);

    const id = createUUIDv7();
    const assetPath = `index.${build.platform}.bundle`;
    const bundleDir = path.join(workDir, "bundle");
    const builtInBundlePath = path.join(bundleDir, assetPath);
    await (
      build.platform === "android"
        ? extractAndroidBuiltInBundle
        : extractIosBuiltInBundle
    )({
      artifactPath: build.artifactPath,
      outputPath: builtInBundlePath,
    });
    const targetFiles = [{ path: builtInBundlePath, name: assetPath }];
    const manifest = await createBundleManifest({
      bundleId: build.minBundleId,
      targetFiles,
    });
    const assetUploadTargets = await prepareContentAddressedAssetUploadTargets({
      manifest,
      outputPath: workDir,
      targetFiles,
    });
    const manifestPath = await writeBundleManifestFile({
      buildPath: bundleDir,
      manifest,
    });

    // A simulator `.app` is a directory: it is stored as one zip archive.
    const artifactFile =
      build.artifactKind === "app"
        ? path.join(workDir, `${path.basename(build.artifactPath)}.zip`)
        : build.artifactPath;
    if (build.artifactKind === "app") {
      await archiveAppBundle({
        appPath: build.artifactPath,
        outputPath: artifactFile,
      });
    }

    p.log.info(`Uploading the native build to ${storage.name}`);
    const manifestUpload = await putStorageFile(
      storage,
      createBundleStorageKey(build.minBundleId),
      manifestPath,
    );
    const assetBaseStorageUri = createStorageRootUriWithPath(
      manifestUpload.storageUri,
      build.minBundleId,
      "assets",
    );
    await runWithConcurrency(
      assetUploadTargets,
      MANIFEST_ASSET_UPLOAD_CONCURRENCY,
      async (target) => {
        await uploadContentAddressedAsset(storage, assetBaseStorageUri, target);
      },
    );
    const artifactUpload = await putStorageFile(
      storage,
      [NATIVE_BUILD_STORAGE_PREFIX, build.platform, id].join("/"),
      artifactFile,
    );

    const row = await core.registerNativeBuild({
      ...scope,
      id,
      minBundleId: build.minBundleId,
      gitCommitHash: (await getLatestGitCommit())?.id() ?? null,
      artifact: {
        kind: build.artifactKind,
        storageUri: artifactUpload.storageUri,
        byteSize: artifactUpload.byteSize,
      },
      embeddedBundle: {
        manifestStorageUri: manifestUpload.storageUri,
        manifestFileHash: await getFileHashFromFile(manifestPath),
        assetBaseStorageUri,
        metadata:
          build.appVersion === null ? {} : { app_version: build.appVersion },
      },
    });
    p.log.success(
      ui.line([
        "Registered native build",
        ui.id(row.id),
        ui.muted(`built-in bundle ${row.min_bundle_id}`),
      ]),
    );
    return row;
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
    await server.dispose();
  }
};
