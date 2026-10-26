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
  type NativeBuildRegistration,
  type NativeBuildRow,
  type NativeBuildScope,
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
import { type LoadedServer, loadServer } from "../loadServer";
import type { NativeBuildResult } from "./createNativeBuild";

/** Where a native build's artifact is stored, under the config's storage. */
export const NATIVE_BUILD_STORAGE_PREFIX = "native-builds";

/**
 * Deletes the artifact of a registration that failed, which no `storage
 * prune` reclaims. A registration that committed although its write failed,
 * or that cannot be checked, keeps it. The built-in bundle's manifest and
 * file stay for `storage prune`.
 */
const removeUnregisteredArtifact = async (
  { core, storage }: Pick<LoadedServer, "core" | "storage">,
  registration: NativeBuildRegistration,
) => {
  try {
    // Only this registration writes its built-in bundle's row.
    const committed = await core.getBundle(registration.minBundleId);
    if (committed !== null || storage.delete === undefined) return;
    await storage.delete({ storageUri: registration.artifact.storageUri });
  } catch {
    p.log.warn(
      `The native build was not registered, and its artifact stays at ${registration.artifact.storageUri}.`,
    );
  }
};

/**
 * Checks, before a build, that it can be tracked: the config's server
 * answers the registry for `scope`, and its storage stores and reads
 * objects. When the registry holds a build for `scope`, its artifact is
 * read back (`exists`), with the server's real storage location; with
 * none, nothing stored names one yet, and no write is probed: the first
 * upload after the build is the check. Without a scope, as before a build
 * adapter's prebuild writes the native projects it reads from, the
 * registry's newest build stands in for it.
 */
export const preflightNativeBuildRegistration = async (
  scope: NativeBuildScope | null,
): Promise<void> => {
  const server = await loadServer(await loadConfig(null));
  try {
    const { core, storage } = server;
    /** What the build can't reach, with why. */
    const unreachable = (what: string, error: unknown) =>
      new Error(
        `${what}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    const where = `its ${storage.name} storage`;
    if (storage.put === undefined || storage.exists === undefined) {
      throw unreachable(
        where,
        new Error(
          `the storage adapter does not implement ${storage.put === undefined ? "put" : "exists"}.`,
        ),
      );
    }
    let found: NativeBuildRow | null;
    try {
      found =
        scope === null
          ? ((await core.listNativeBuilds({ order: "desc", limit: 1 }))[0] ??
            null)
          : await core.findNativeBuild(scope);
    } catch (error) {
      throw unreachable("its native build registry", error);
    }
    if (found !== null) {
      try {
        await storage.exists({ storageUri: found.artifact_storage_uri });
      } catch (error) {
        throw unreachable(where, error);
      }
    }
  } finally {
    await server.dispose();
  }
};

/**
 * Registers a release build in the native build registry, with the
 * credentials deploy uses: the config's database and storage. It uploads the
 * artifact under `native-builds/<platform>/<id>/`, and the built-in bundle,
 * taken byte for byte from the artifact, as a bundle whose manifest lists
 * only its JavaScript bundle file, at the path an OTA bundle's manifest
 * gives it. No release publishes that bundle. `buildKey` is the native
 * build key of the build's inputs, which a later build with the same inputs
 * finds it by, or null for a build no key covers.
 */
export const registerNativeBuild = async (
  build: NativeBuildResult,
  { buildKey }: { readonly buildKey: string | null },
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

    const registration: NativeBuildRegistration = {
      ...scope,
      id,
      minBundleId: build.minBundleId,
      gitCommitHash: (await getLatestGitCommit())?.id() ?? null,
      buildKey,
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
    };
    let row: NativeBuildRow;
    try {
      row = await core.registerNativeBuild(registration);
    } catch (error) {
      await removeUnregisteredArtifact(server, registration);
      throw error;
    }
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
