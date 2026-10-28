import fs from "fs";
import os from "os";
import path from "path";

import { extractBuiltInBundle as extractAndroidBuiltInBundle } from "@hot-updater/android-helper";
import {
  archiveAppBundle,
  extractBuiltInBundle as extractIosBuiltInBundle,
} from "@hot-updater/apple-helper";
import {
  createMinBundleId,
  loadConfig,
  p,
  putStorageFile,
} from "@hot-updater/cli-tools";
import {
  assertStorageOperations,
  DatabaseConstraintError,
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
import type { NativeBuildResult, NativeBuildTarget } from "./createNativeBuild";

/** Where a native build's artifact is stored, under the config's storage. */
export const NATIVE_BUILD_STORAGE_PREFIX = "native-builds";

/**
 * How many milliseconds past the build's a MIN_BUNDLE_ID steps while the
 * registry holds a bundle at it.
 */
const MIN_BUNDLE_ID_STEPS = 10;

/**
 * A registration the registry refused because its build or its built-in
 * bundle exists: core's constraint error, or a self-hosted server's 409.
 */
export const isNativeBuildConflict = (error: unknown): boolean =>
  (error instanceof DatabaseConstraintError &&
    (error.reason === "unique" || error.reason === "exists")) ||
  (error as { status?: unknown } | null)?.status === 409;

/**
 * Issues the MIN_BUNDLE_ID of a build about to start, the zero-random-bit
 * UUIDv7 of its millisecond (`createMinBundleId`). Bundle IDs share one
 * space across platforms, so a bundle the registry already holds at that ID,
 * such as the built-in bundle of a build that started in the same
 * millisecond, steps it 1 ms forward, with one read of the config's server
 * per step. Builds that start together register nothing before they finish,
 * so this read can't see each other: the registry, which takes a built-in
 * bundle's ID once, refuses the second registration.
 */
export const issueMinBundleId = async (nowMs = Date.now()): Promise<string> => {
  const server = await loadServer(await loadConfig(null));
  try {
    let id = createMinBundleId(nowMs);
    for (
      let step = 1;
      step <= MIN_BUNDLE_ID_STEPS && (await server.core.getBundle(id)) !== null;
      step += 1
    ) {
      id = createMinBundleId(nowMs + step);
    }
    return id;
  } finally {
    await server.dispose();
  }
};

/**
 * Deletes the artifact and the manifest of a registration that failed: both
 * are its own (the manifest sits under the registration's ID), and no
 * `storage prune` reclaims them while another build registered the same
 * built-in bundle. A registration that committed although its write failed,
 * or that cannot be checked, keeps them. The built-in bundle's file is
 * content-addressed and shared; it stays for `storage prune`.
 */
const removeUnregisteredArtifact = async (
  { core, storage }: Pick<LoadedServer, "core" | "storage">,
  registration: NativeBuildRegistration,
) => {
  try {
    // Its own row, by its own ID: another import of the same artifact may
    // have written the built-in bundle's row.
    const committed = await core.getNativeBuild(registration.id);
    if (committed !== null || storage.delete === undefined) return;
    await storage.delete({ storageUri: registration.artifact.storageUri });
    await storage.delete({
      storageUri: registration.embeddedBundle.manifestStorageUri,
    });
  } catch {
    p.log.warn(
      `The native build wasn't registered; its artifact stays at:\n${registration.artifact.storageUri}`,
    );
  }
};

/** What a build can't be tracked without, such as the registry, and why. */
export class NativeBuildUnreachableError extends Error {
  constructor(
    /** What the build can't reach, such as "the native build registry". */
    readonly what: string,
    /** Why, as the server or storage said. */
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`${what}: ${reason}`, options);
    this.name = "NativeBuildUnreachableError";
  }
}

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
      new NativeBuildUnreachableError(
        what,
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    const where = `the ${storage.name} storage`;
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
      throw unreachable("the native build registry", error);
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
  build: NativeBuildTarget &
    Omit<NativeBuildResult, "scheme" | keyof NativeBuildTarget>,
  {
    buildKey,
    gitCommitHash,
    writeBuiltInBundle,
  }: {
    readonly buildKey: string | null;
    /**
     * The commit the build was made from: this checkout's latest by
     * default, and null for a build imported from elsewhere.
     */
    readonly gitCommitHash?: string | null;
    /**
     * Writes the built-in bundle to `outputPath`: by default the platform
     * helper extracts it from the artifact.
     */
    readonly writeBuiltInBundle?: (outputPath: string) => Promise<void>;
  },
): Promise<NativeBuildRow> => {
  if (build.minBundleId === NIL_UUID) {
    throw new Error(
      "A Debug build has no built-in bundle to register.\nBuild a release variant or configuration.",
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
    if (writeBuiltInBundle !== undefined) {
      await writeBuiltInBundle(builtInBundlePath);
    } else {
      await (
        build.platform === "android"
          ? extractAndroidBuiltInBundle
          : extractIosBuiltInBundle
      )({
        artifactPath: build.artifactPath,
        outputPath: builtInBundlePath,
      });
    }
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

    // A simulator `.app` is a directory: it is stored as one zip archive,
    // unless it is one already (an imported `.app.zip`).
    const archive =
      build.artifactKind === "app" && !build.artifactPath.endsWith(".zip");
    const artifactFile = archive
      ? path.join(workDir, `${path.basename(build.artifactPath)}.zip`)
      : build.artifactPath;
    if (archive) {
      await archiveAppBundle({
        appPath: build.artifactPath,
        outputPath: artifactFile,
      });
    }

    p.log.info(`Uploading the native build to ${storage.name}`);
    // The manifest's key names this registration: two imports of the same
    // MIN_BUNDLE_ID upload before the registry takes one, so a shared key
    // would let the refused one overwrite the registered build's manifest.
    const manifestUpload = await putStorageFile(
      storage,
      createBundleStorageKey(build.minBundleId, id),
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
      gitCommitHash:
        gitCommitHash === undefined
          ? ((await getLatestGitCommit())?.id() ?? null)
          : gitCommitHash,
      buildKey,
      buildNumber: build.buildNumber ?? null,
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
      ui.summary("Native build registered", [
        ["ID", ui.id(row.id)],
        ["Built-in bundle", ui.id(row.min_bundle_id)],
      ]),
    );
    return row;
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
    await server.dispose();
  }
};
