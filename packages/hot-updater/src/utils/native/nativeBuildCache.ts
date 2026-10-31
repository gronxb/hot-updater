import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { extractAppBundle } from "@hot-updater/apple-helper";
import { loadConfig } from "@hot-updater/cli-tools";
import type {
  NativeBuildRow,
  NativeBuildScope,
  StorageAdapter,
} from "@hot-updater/plugin-core";

import { loadServer } from "../loadServer";
import type { NativeBuildKeyComponents } from "./buildKey";
import type { NativeBuildResult } from "./createNativeBuild";

/**
 * The newest build of a platform and scheme on this machine, as its slot's
 * meta.json records it, beside the build's output in `artifact/`. It holds
 * the key's components, so a later key can say what changed, and digests,
 * names, and versions only: never a secret.
 */
export interface CachedNativeBuild {
  readonly version: 1;
  readonly key: string;
  readonly components: NativeBuildKeyComponents;
  /** The build, its artifact's path relative to `artifact/`. */
  readonly build: NativeBuildResult;
  /** The registry's record of the build, once it is tracked. */
  readonly nativeBuildId: string | null;
}

const META = "meta.json";
const ENTRY = "entry";
const ARTIFACT = "artifact";

/**
 * Where a platform and scheme's cached build is: one slot each, which a new
 * build replaces, so the cache never holds more than one build of a scheme.
 */
export const nativeBuildCacheSlot = (
  cacheDir: string,
  platform: string,
  scheme: string,
) => path.join(cacheDir, "native-build", platform, encodeURIComponent(scheme));

/** Copies a file or directory, as a clone where the file system can. */
const copy = async (from: string, to: string) => {
  await fs.promises.rm(to, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.cp(from, to, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
  });
};

/** The slot's cached build, or null when it has none or one this CLI can't read. */
export const readCachedNativeBuild = async (
  slot: string,
): Promise<CachedNativeBuild | null> => {
  try {
    const meta = JSON.parse(
      await fs.promises.readFile(path.join(slot, ENTRY, META), "utf8"),
    ) as CachedNativeBuild;
    if (meta.version !== 1 || typeof meta.key !== "string") return null;
    await fs.promises.access(
      path.join(slot, ENTRY, ARTIFACT, meta.build.artifactPath),
    );
    return meta;
  } catch {
    return null;
  }
};

/**
 * Replaces the slot's cached build with `build`, whose output directory is
 * `outputPath`. The new entry is written beside the old one and renamed over
 * it, so a run that stops halfway leaves the old entry or the new one, never
 * a mix of the two.
 */
export const saveCachedNativeBuild = async ({
  slot,
  key,
  components,
  build,
  outputPath,
  nativeBuildId,
}: {
  slot: string;
  key: string;
  components: NativeBuildKeyComponents;
  build: NativeBuildResult;
  outputPath: string;
  nativeBuildId: string | null;
}): Promise<void> => {
  await fs.promises.mkdir(slot, { recursive: true });
  const staging = await fs.promises.mkdtemp(path.join(slot, ".staging-"));
  try {
    await copy(outputPath, path.join(staging, ARTIFACT));
    const meta: CachedNativeBuild = {
      version: 1,
      key,
      components,
      build: {
        ...build,
        artifactPath: path.relative(outputPath, build.artifactPath),
      },
      nativeBuildId,
    };
    await fs.promises.writeFile(path.join(staging, META), JSON.stringify(meta));
    const entry = path.join(slot, ENTRY);
    const old = path.join(slot, `.old-${process.pid}-${Date.now()}`);
    await fs.promises.rename(entry, old).catch(() => undefined);
    await fs.promises.rename(staging, entry);
    await fs.promises.rm(old, { recursive: true, force: true });
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
};

/** Records the registry's ID of the slot's build, once it is tracked. */
export const markCachedNativeBuildTracked = async (
  slot: string,
  key: string,
  nativeBuildId: string,
): Promise<void> => {
  const cached = await readCachedNativeBuild(slot);
  if (cached === null || cached.key !== key) return;
  const file = path.join(slot, ENTRY, META);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(
    temporary,
    JSON.stringify({ ...cached, nativeBuildId }),
  );
  await fs.promises.rename(temporary, file);
};

/**
 * Copies the slot's cached build to `outputPath`, as a build copies its
 * output there, and returns the build with its artifact there.
 */
export const restoreCachedNativeBuild = async (
  slot: string,
  cached: CachedNativeBuild,
  outputPath: string,
): Promise<NativeBuildResult> => {
  await copy(path.join(slot, ENTRY, ARTIFACT), outputPath);
  return {
    ...cached.build,
    artifactPath: path.join(outputPath, cached.build.artifactPath),
  };
};

/** The scope a cached build was tracked in. */
export const cachedNativeBuildScope = ({
  build,
}: CachedNativeBuild): NativeBuildScope =>
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

/**
 * Downloads a tracked build's artifact into `outputPath`: an `.ipa`, `.apk`,
 * or `.aab` as it was stored, and a simulator `.app`, stored as one zip
 * archive, unpacked.
 */
const downloadArtifact = async (
  storage: StorageAdapter,
  nativeBuild: NativeBuildRow,
  outputPath: string,
): Promise<string> => {
  const storageUri = nativeBuild.artifact_storage_uri;
  let response: Response | null = null;
  if (storage.get !== undefined) {
    ({ response } = await storage.get({ storageUri }));
  } else if (storage.getDownloadUrl !== undefined) {
    response = await fetch((await storage.getDownloadUrl({ storageUri })).url);
  } else {
    throw new Error(
      `the ${storage.name} storage adapter implements neither get nor getDownloadUrl`,
    );
  }
  if (!response?.ok || !response.body) {
    throw new Error(
      `the ${storage.name} storage answered ${response ? `HTTP ${response.status}` : "no object"} for ${storageUri}`,
    );
  }
  const fileName = decodeURIComponent(storageUri.split("/").at(-1) ?? "");
  await fs.promises.rm(outputPath, { recursive: true, force: true });
  await fs.promises.mkdir(outputPath, { recursive: true });
  if (nativeBuild.artifact_kind !== "app") {
    const file = path.join(outputPath, fileName);
    await pipeline(
      Readable.fromWeb(response.body as never),
      fs.createWriteStream(file),
    );
    return file;
  }
  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-native-build-"),
  );
  try {
    const archive = path.join(workDir, fileName);
    await pipeline(
      Readable.fromWeb(response.body as never),
      fs.createWriteStream(archive),
    );
    await extractAppBundle({ archivePath: archive, outputPath });
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
  const app = (await fs.promises.readdir(outputPath)).find((name) =>
    name.endsWith(".app"),
  );
  if (!app) throw new Error(`${fileName} holds no .app`);
  return path.join(outputPath, app);
};

/** A cached build the command reuses instead of building. */
export type NativeBuildCacheHit =
  | {
      /** A build the registry tracks with this key, whose artifact is in storage. */
      readonly source: "storage";
      readonly nativeBuild: NativeBuildRow;
      readonly result: NativeBuildResult;
    }
  | {
      /** This machine's cached build of the scheme, which may not be tracked yet. */
      readonly source: "local";
      readonly nativeBuildId: string | null;
      readonly result: NativeBuildResult;
    };

export interface NativeBuildCacheLookup {
  readonly hit: NativeBuildCacheHit | null;
  /** The slot's cached build, whatever its key. */
  readonly cached: CachedNativeBuild | null;
  /**
   * A tracked build with this key whose artifact is gone from storage: the
   * slot's build, which may be that build, is not reused either, since its
   * built-in bundle is already registered.
   */
  readonly missingArtifact: NativeBuildRow | null;
  /**
   * Whether the slot's build with this key has a MIN_BUNDLE_ID the registry
   * holds for another build, as one that started in the same millisecond
   * registers first: it can't be tracked, so it is not reused either.
   */
  readonly takenMinBundleId: boolean;
}

/**
 * Finds a build to reuse for `key`: the registry's newest build of the scope
 * with that key, whose artifact storage still holds, copied from this
 * machine's slot when it is the same build and downloaded otherwise; else
 * this machine's cached build of the scheme. The scope is the cached build's
 * when the slot has this key, since it is what the build embedded, and
 * `predictedScope` otherwise.
 */
export const findCachedNativeBuild = async ({
  key,
  scheme,
  slot,
  predictedScope,
  outputPath,
}: {
  key: string;
  /** The `nativeBuild` scheme the build is of. */
  scheme: string;
  slot: string | null;
  predictedScope: NativeBuildScope;
  outputPath: string;
}): Promise<NativeBuildCacheLookup> => {
  const cached = slot === null ? null : await readCachedNativeBuild(slot);
  const local = cached?.key === key ? cached : null;
  const server = await loadServer(await loadConfig(null));
  try {
    const found = await server.core.findNativeBuild(
      local ? cachedNativeBuildScope(local) : predictedScope,
      { buildKey: key },
    );
    // An older server ignores the key and answers the scope's newest build.
    const nativeBuild = found?.build_key === key ? found : null;
    if (nativeBuild !== null) {
      const { exists } = (await server.storage.exists?.({
        storageUri: nativeBuild.artifact_storage_uri,
      })) ?? { exists: false };
      if (!exists) {
        return {
          hit: null,
          cached,
          missingArtifact: nativeBuild,
          takenMinBundleId: false,
        };
      }
      const result: NativeBuildResult =
        local && local.build.minBundleId === nativeBuild.min_bundle_id
          ? await restoreCachedNativeBuild(slot!, local, outputPath)
          : {
              platform: nativeBuild.platform,
              scheme,
              minBundleId: nativeBuild.min_bundle_id,
              channel: (local ? cachedNativeBuildScope(local) : predictedScope)
                .channel,
              ...(nativeBuild.fingerprint_hash === null
                ? {
                    fingerprintHash: null,
                    appVersion: nativeBuild.app_version!,
                  }
                : {
                    fingerprintHash: nativeBuild.fingerprint_hash,
                    appVersion: null,
                  }),
              artifactPath: await downloadArtifact(
                server.storage,
                nativeBuild,
                outputPath,
              ),
              artifactKind: nativeBuild.artifact_kind,
              buildNumber: nativeBuild.build_number,
            };
      return {
        hit: { source: "storage", nativeBuild, result },
        cached,
        missingArtifact: null,
        takenMinBundleId: false,
      };
    }
    if (local === null) {
      return {
        hit: null,
        cached,
        missingArtifact: null,
        takenMinBundleId: false,
      };
    }
    // No build the registry tracks has this key, so a bundle at the cached
    // build's MIN_BUNDLE_ID is another build's built-in bundle.
    if ((await server.core.getBundle(local.build.minBundleId)) !== null) {
      return {
        hit: null,
        cached,
        missingArtifact: null,
        takenMinBundleId: true,
      };
    }
  } finally {
    await server.dispose();
  }
  return {
    hit: {
      source: "local",
      nativeBuildId: local.nativeBuildId,
      result: await restoreCachedNativeBuild(slot!, local, outputPath),
    },
    cached,
    missingArtifact: null,
    takenMinBundleId: false,
  };
};
