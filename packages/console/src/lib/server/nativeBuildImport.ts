import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createBrotliCompress } from "node:zlib";

import {
  assertStorageOperations,
  createBundleStorageKey,
  createStorageRootUriWithPath,
  createStorageUriWithRelativePath,
  createUUIDv7,
  DatabaseConstraintError,
  getManifestAssetDownloadPath,
  getManifestAssetStoragePath,
  type HotUpdaterCoreApi,
  type NativeBuildRegistration,
  type NativeBuildRow,
  type NativeBuildScope,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import {
  alreadyImportedProblem,
  blobSource,
  type ByteSource,
  checkNativeArtifact,
  type ImportableNativeBuild,
  NativeArtifactError,
  type NativeArtifactInfo,
  type NativeArtifactProblem,
  nativeArtifactKindOf,
  openZipEntry,
  readNativeArtifact,
  readZipDirectory,
} from "@hot-updater/protocol/native-artifact";

/**
 * The largest artifact the Console takes: a store `.ipa` or `.aab` is rarely
 * over a few hundred megabytes. `native-build import` in the CLI takes any.
 */
export const NATIVE_BUILD_IMPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Where a native build's artifact is stored, as the CLI stores it. */
const NATIVE_BUILD_STORAGE_PREFIX = "native-builds";

/** How many native builds one read of the registry takes. */
const LIST_PAGE = 100;

export type UpdateStrategy = "fingerprint" | "appVersion";

/** What the Console checked of an artifact, before or after its upload. */
export type NativeBuildImportCheck =
  | {
      readonly ok: true;
      readonly updateStrategy: UpdateStrategy;
      readonly build: ImportableNativeBuild;
    }
  | {
      readonly ok: false;
      readonly updateStrategy: UpdateStrategy;
      readonly problems: readonly NativeArtifactProblem[];
    };

/** An import the Console refuses, as a response the drop zone shows. */
export class NativeBuildImportRefusal extends Error {
  override readonly name = "NativeBuildImportRefusal";

  constructor(
    readonly status: number,
    readonly problems: readonly NativeArtifactProblem[],
  ) {
    super(problems.map(({ message }) => message).join(" "));
  }
}

/**
 * The update strategy an imported build registers by: the config's, which
 * `hot-updater console` takes from hot-updater.config.ts; else the newest
 * registered build's, which deploy found it by; else, with an empty
 * registry, the artifact's own, which compiles a fingerprint in only for
 * the fingerprint strategy.
 */
export const resolveUpdateStrategy = async (
  core: Pick<HotUpdaterCoreApi, "listNativeBuilds">,
  configured: UpdateStrategy | undefined,
  info: Pick<NativeArtifactInfo, "fingerprintCandidates">,
): Promise<UpdateStrategy> => {
  if (configured !== undefined) return configured;
  const [newest] = await core.listNativeBuilds({ order: "desc", limit: 1 });
  if (newest !== undefined) {
    return newest.fingerprint_hash === null ? "appVersion" : "fingerprint";
  }
  return info.fingerprintCandidates.length > 0 ? "fingerprint" : "appVersion";
};

const scopeOf = (build: ImportableNativeBuild): NativeBuildScope =>
  build.fingerprintHash === null
    ? {
        platform: build.platform,
        channel: build.channel,
        fingerprintHash: null,
        appVersion: build.appVersion!,
      }
    : {
        platform: build.platform,
        channel: build.channel,
        fingerprintHash: build.fingerprintHash,
        appVersion: null,
      };

/**
 * The native build whose built-in bundle is `minBundleId`, or null when a
 * bundle that is no native build's has that ID, or undefined when the ID is
 * free. Only an artifact already registered pages the registry.
 */
const findRegistered = async (
  core: HotUpdaterCoreApi,
  scope: NativeBuildScope,
  minBundleId: string,
): Promise<NativeBuildRow | null | undefined> => {
  if ((await core.getBundle(minBundleId)) === null) return undefined;
  const newest = await core.findNativeBuild(scope);
  if (newest?.min_bundle_id === minBundleId) return newest;
  let after: string | undefined;
  for (;;) {
    const page = await core.listNativeBuilds({
      order: "desc",
      limit: LIST_PAGE,
      ...(after === undefined ? {} : { after }),
    });
    const found = page.find((row) => row.min_bundle_id === minBundleId);
    if (found !== undefined) return found;
    if (page.length < LIST_PAGE) return null;
    after = page.at(-1)!.id;
  }
};

/**
 * Whether an artifact the browser read can be imported: the same check as
 * `native-build import`, and whether its build is already registered. The
 * upload checks the artifact itself again; this only spares uploading one
 * the Console would refuse.
 */
export const checkNativeBuildImport = async (
  core: HotUpdaterCoreApi,
  configured: UpdateStrategy | undefined,
  info: NativeArtifactInfo,
): Promise<NativeBuildImportCheck> => {
  const updateStrategy = await resolveUpdateStrategy(core, configured, info);
  const check = checkNativeArtifact(info, { updateStrategy });
  if (!check.ok) return { ...check, updateStrategy };
  const registered = await findRegistered(
    core,
    scopeOf(check.build),
    check.build.minBundleId,
  );
  if (registered !== undefined) {
    return {
      ok: false,
      updateStrategy,
      problems: [
        alreadyImportedProblem(check.build.minBundleId, registered?.id ?? null),
      ],
    };
  }
  return { ok: true, updateStrategy, build: check.build };
};

/** A file name as the artifact's storage key ends: its base name only. */
const artifactFileName = (fileName: string, kind: string) => {
  const base = fileName.split(/[\\/]/u).at(-1)?.trim() ?? "";
  return /^[\w.@()+ -]+$/u.test(base) && nativeArtifactKindOf(base) === kind
    ? base
    : `app.${kind}`;
};

const sha256Hex = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Writes `body` to `file`, refusing more than `maxBytes`. */
const spool = async (
  body: ReadableStream<Uint8Array>,
  file: string,
  maxBytes: number,
) => {
  let received = 0;
  await pipeline(
    Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength;
        callback(
          received > maxBytes
            ? new NativeBuildImportRefusal(413, [
                {
                  code: "UNREADABLE",
                  message: `The file is larger than the Console takes (${maxBytes} bytes). Import it with \`hot-updater native-build import\`.`,
                },
              ])
            : null,
          chunk,
        );
      },
    }),
    fs.createWriteStream(file),
  );
  return received;
};

/** The built-in bundle's bytes, out of the artifact. */
const readBuiltInBundle = async (source: ByteSource, entryName: string) => {
  const entry = (await readZipDirectory(source)).find(
    ({ name }) => name === entryName,
  );
  if (entry === undefined) {
    throw new NativeBuildImportRefusal(422, [
      {
        code: "NO_BUILT_IN_BUNDLE",
        message: `The artifact has no ${entryName}.`,
      },
    ]);
  }
  return new Uint8Array(
    await new Response(await openZipEntry(source, entry)).arrayBuffer(),
  );
};

const brotli = async (bytes: Uint8Array) => {
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from([bytes]),
    createBrotliCompress({
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
  );
  return new Uint8Array(Buffer.concat(chunks));
};

const bytesBody = (bytes: Uint8Array) =>
  new Blob([bytes.slice()]).stream() as ReadableStream<Uint8Array>;

/**
 * Imports a store artifact the request's body carries, as `hot-updater
 * native-build import` does: it spools the body to a temporary file, reads
 * and checks the artifact itself (not what the browser read), refuses one
 * already registered, then uploads the artifact under
 * `native-builds/<platform>/<id>/` and the built-in bundle as a bundle
 * whose manifest lists only its JavaScript file, and registers both with no
 * build key and no commit.
 */
export const importNativeBuild = async ({
  body,
  fileName,
  core,
  storage,
  updateStrategy: configured,
  maxBytes = NATIVE_BUILD_IMPORT_MAX_BYTES,
}: {
  readonly body: ReadableStream<Uint8Array>;
  readonly fileName: string;
  readonly core: HotUpdaterCoreApi;
  readonly storage: StorageAdapter;
  readonly updateStrategy: UpdateStrategy | undefined;
  readonly maxBytes?: number;
}): Promise<NativeBuildRow> => {
  const kind = nativeArtifactKindOf(fileName);
  if (kind === null) {
    throw new NativeBuildImportRefusal(415, [
      {
        code: "UNSUPPORTED_FILE",
        message: `${fileName} is not an .ipa, .aab or .apk. Import the store artifact of a release build.`,
      },
    ]);
  }
  assertStorageOperations(storage, ["put", "exists"]);
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-native-build-import-"),
  );
  try {
    const file = path.join(dir, `artifact.${kind}`);
    const byteSize = await spool(body, file, maxBytes);
    const source = blobSource(await fs.openAsBlob(file));
    let info: NativeArtifactInfo;
    try {
      info = await readNativeArtifact(source, fileName);
    } catch (error) {
      if (error instanceof NativeArtifactError) {
        throw new NativeBuildImportRefusal(422, [
          { code: error.code, message: error.message },
        ]);
      }
      throw error;
    }
    const check = await checkNativeBuildImport(core, configured, info);
    if (!check.ok) {
      throw new NativeBuildImportRefusal(
        check.problems.some(({ code }) => code === "ALREADY_IMPORTED")
          ? 409
          : 422,
        check.problems,
      );
    }
    const { build } = check;
    const scope = scopeOf(build);

    // The built-in bundle, as deploy stores a JavaScript bundle: Brotli at
    // quality 11, content-addressed under the shared asset root.
    const assetPath = `index.${build.platform}.bundle`;
    const bundle = await readBuiltInBundle(source, build.builtInBundlePath);
    const fileHash = sha256Hex(bundle);
    const downloadPath = getManifestAssetDownloadPath(assetPath);
    const download = downloadPath === assetPath ? bundle : await brotli(bundle);
    const downloadFileHash =
      download === bundle ? undefined : sha256Hex(download);
    const manifestText = `${JSON.stringify(
      {
        bundleId: build.minBundleId,
        assets: {
          [assetPath]: {
            byteSize: bundle.byteLength,
            fileHash,
            downloadByteSize: download.byteLength,
            ...(downloadFileHash === undefined ? {} : { downloadFileHash }),
          },
        },
      },
      null,
      2,
    )}\n`;
    const manifestBytes = new TextEncoder().encode(manifestText);
    const manifestUpload = await storage.put({
      key: `${createBundleStorageKey(build.minBundleId)}/manifest.json`,
      body: bytesBody(manifestBytes),
      contentLength: manifestBytes.byteLength,
      contentType: "application/json",
    });
    const assetBaseStorageUri = createStorageRootUriWithPath(
      manifestUpload.storageUri,
      build.minBundleId,
      "assets",
    );
    const storagePath = getManifestAssetStoragePath({
      assetPath: downloadPath,
      downloadFileHash,
      fileHash,
    });
    const assetUri = createStorageUriWithRelativePath({
      baseStorageUri: assetBaseStorageUri,
      relativePath: storagePath,
    });
    if (!(await storage.exists({ storageUri: assetUri })).exists) {
      await storage.put({
        key: ["assets", storagePath].join("/"),
        body: bytesBody(download),
        contentLength: download.byteLength,
        contentType: "application/octet-stream",
      });
    }

    const id = createUUIDv7();
    const artifactName = artifactFileName(fileName, kind);
    const artifactUpload = await storage.put({
      key: [NATIVE_BUILD_STORAGE_PREFIX, build.platform, id, artifactName].join(
        "/",
      ),
      body: Readable.toWeb(
        fs.createReadStream(file),
      ) as ReadableStream<Uint8Array>,
      contentLength: byteSize,
      contentType: "application/octet-stream",
    });

    const registration: NativeBuildRegistration = {
      ...scope,
      id,
      minBundleId: build.minBundleId,
      // Built elsewhere: no commit of the Console's, and no build key.
      gitCommitHash: null,
      buildKey: null,
      artifact: {
        kind: build.kind,
        storageUri: artifactUpload.storageUri,
        byteSize,
      },
      embeddedBundle: {
        manifestStorageUri: manifestUpload.storageUri,
        manifestFileHash: sha256Hex(manifestBytes),
        assetBaseStorageUri,
        metadata:
          build.appVersion === null ? {} : { app_version: build.appVersion },
      },
    };
    try {
      return await core.registerNativeBuild(registration);
    } catch (error) {
      await removeUnregisteredArtifact(core, storage, registration);
      if (
        (error instanceof DatabaseConstraintError &&
          (error.reason === "unique" || error.reason === "exists")) ||
        (error as { status?: unknown } | null)?.status === 409
      ) {
        // Another import of the same build won the write.
        const registered = await findRegistered(core, scope, build.minBundleId);
        throw new NativeBuildImportRefusal(409, [
          alreadyImportedProblem(build.minBundleId, registered?.id ?? null),
        ]);
      }
      throw error;
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
};

/**
 * Deletes the artifact of a registration that failed, which no `storage
 * prune` reclaims, unless its own row committed. The built-in bundle's
 * manifest and file stay for `storage prune`.
 */
const removeUnregisteredArtifact = async (
  core: HotUpdaterCoreApi,
  storage: StorageAdapter,
  registration: NativeBuildRegistration,
) => {
  try {
    if ((await core.getNativeBuild(registration.id)) !== null) return;
    await storage.delete?.({ storageUri: registration.artifact.storageUri });
  } catch {
    // The artifact stays; the registration's own error is the one to show.
  }
};
