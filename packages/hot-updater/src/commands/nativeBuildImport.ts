import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import { archiveAppBundle } from "@hot-updater/apple-helper";
import { loadConfig, p } from "@hot-updater/cli-tools";
import {
  type HotUpdaterCoreApi,
  type NativeBuildRow,
  type NativeBuildScope,
} from "@hot-updater/plugin-core";
import { encodeChannelKey } from "@hot-updater/protocol";
import {
  alreadyImportedProblem,
  blobSource,
  type ByteSource,
  checkNativeArtifact,
  findZipEntry,
  NativeArtifactError,
  openZipEntry,
  readNativeArtifact,
  readZipDirectory,
  type ImportableNativeBuild,
  type NativeArtifactInfo,
  type NativeArtifactProblem,
} from "@hot-updater/protocol/native-artifact";

import { type Row, ARTIFACT_PATH_WIDTH, ui } from "../utils/cli-ui";
import { formatBytes } from "../utils/formatBytes";
import { type LoadedServer, loadServer } from "../utils/loadServer";
import {
  isNativeBuildConflict,
  registerNativeBuild,
} from "../utils/native/registerNativeBuild";
import { printBanner } from "../utils/printBanner";
import { safeDispose } from "./release";

export interface NativeBuildImportOptions {
  /** Reads and checks the artifact, and records nothing. */
  readonly dryRun?: boolean;
  readonly json?: boolean;
  /**
   * The channel the app reports, when it isn't the one the artifact
   * compiled in: one its code sets, or one it switches to at runtime.
   */
  readonly channel?: string;
}

/** How many native builds one read of the registry takes. */
const LIST_PAGE = 100;

/**
 * The native build whose built-in bundle is `minBundleId`, or null when a
 * bundle that is no native build's has that ID, or undefined when the ID is
 * free. Only an artifact already registered pages the registry, newest
 * first, to name the build.
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

/** The app identifiers the config's `nativeBuild` schemes declare. */
const declaredAppIds = (
  config: Awaited<ReturnType<typeof loadConfig>>,
  platform: "ios" | "android",
): string[] => {
  const ids =
    platform === "ios"
      ? Object.values(config.nativeBuild.ios).map(
          (scheme) => scheme?.bundleIdentifier,
        )
      : // A scheme's application ID defaults to its package name.
        Object.values(config.nativeBuild.android).map(
          (scheme) => scheme?.applicationId ?? scheme?.packageName,
        );
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
};

const describeArtifact = (
  file: string,
  byteSize: number,
  info: NativeArtifactInfo,
  updateStrategy: "fingerprint" | "appVersion",
  channel: string | undefined,
) => {
  const text = (value: NativeArtifactInfo["channel"]) =>
    value === null ? null : typeof value === "string" ? value : "unreadable";
  /** One row per candidate, the label on the first. */
  const candidates = (label: string, values: readonly string[]): Row[] =>
    values.length === 0
      ? [[label, ui.muted("none")]]
      : values.map((value, index) => [index === 0 ? label : "", ui.id(value)]);
  return ui.block("Native build artifact", [
    ui.kv("File", ui.path(ui.fitPath(file, ARTIFACT_PATH_WIDTH))),
    ui.kv("Platform", ui.platform(info.platform)),
    ui.kv("Kind", info.kind),
    ui.kv("Size", formatBytes(byteSize)),
    ui.kv("App", info.appId ?? ui.muted("none")),
    ui.kv("App version", ui.version(text(info.appVersion) ?? "none")),
    ui.kv("Build number", info.buildNumber ?? ui.muted("none")),
    ui.kv(
      "Channel",
      channel !== undefined
        ? `${ui.channel(channel)} ${ui.muted(`(--channel; compiled in: ${text(info.channel) ?? "none"})`)}`
        : info.channel === null
          ? `${ui.channel("production")} ${ui.muted("(none compiled in)")}`
          : ui.channel(text(info.channel)),
    ),
    ...candidates("Min bundle ID", info.minBundleIdCandidates),
    ...(updateStrategy === "fingerprint"
      ? candidates("Fingerprint", info.fingerprintCandidates)
      : []),
    ui.kv(
      "Built-in bundle",
      info.builtInBundle === null
        ? ui.muted("none")
        : `${info.builtInBundle.path} ${ui.muted(formatBytes(info.builtInBundle.byteSize))}`,
    ),
  ]);
};

/**
 * Whether the registered `row` is `build`, imported again: the same scope,
 * and a built-in bundle whose file is the artifact's, byte for byte, by the
 * SHA-256 its manifest records.
 */
const isSameBuild = async (
  { core, storage }: Pick<LoadedServer, "core" | "storage">,
  row: NativeBuildRow,
  build: ImportableNativeBuild,
  source: ByteSource,
): Promise<boolean> => {
  if (
    row.platform !== build.platform ||
    row.channel_id !== `channel:${encodeChannelKey(build.channel)}` ||
    row.fingerprint_hash !== build.fingerprintHash ||
    row.app_version !== build.appVersion ||
    storage.get === undefined
  ) {
    return false;
  }
  const detail = await core.getBundle(build.minBundleId);
  if (detail === null) return false;
  const { response } = await storage.get({
    storageUri: detail.bundle.manifest_storage_uri,
  });
  if (response === null || !response.ok) return false;
  const manifest = (await response.json()) as {
    assets?: Record<string, { fileHash?: unknown }>;
  };
  const registered =
    manifest.assets?.[`index.${build.platform}.bundle`]?.fileHash;
  return (
    typeof registered === "string" &&
    registered === (await hashBuiltInBundle(source, build))
  );
};

/** The SHA-256 of the built-in bundle the check found in the artifact. */
const hashBuiltInBundle = async (
  source: ByteSource,
  build: ImportableNativeBuild,
) => {
  const entry = findZipEntry(
    await readZipDirectory(source),
    build.builtInBundlePath,
  );
  if (entry === undefined) return null;
  const hash = createHash("sha256");
  const reader = (await openZipEntry(source, entry)).getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    hash.update(next.value);
  }
  return hash.digest("hex");
};

/**
 * Imports an artifact built elsewhere (EAS, Xcode Cloud, Fastlane, an older
 * build): an `.ipa`, `.aab` or `.apk`, or a simulator `.app` (the directory
 * or its `.app.zip`). It reads what the artifact compiled in (platform, app
 * version, channel, MIN_BUNDLE_ID, fingerprint) and its built-in bundle,
 * refuses an artifact that can't serve as a patch base, then uploads the
 * artifact and the built-in bundle and registers them as `native-build
 * ios|android` does after a build, so OTAs deployed after it patch from its
 * built-in bundle. `--channel` names the channel the app reports when its
 * code sets one, or it switches to one at runtime.
 *
 * Importing the same build again changes nothing and succeeds, reporting
 * the registered build (`alreadyImported`), so a CI job can run again; an
 * artifact whose MIN_BUNDLE_ID is registered with another built-in bundle
 * or scope is refused. With `--dry-run` it reads and checks, and records
 * nothing.
 */
export const handleNativeBuildImport = async (
  file: string,
  options: NativeBuildImportOptions,
) => {
  if (!options.json) printBanner();
  const dryRun = options.dryRun ?? false;
  let warnings: readonly NativeArtifactProblem[] = [];
  const fail = (
    problems: readonly NativeArtifactProblem[],
    artifact: NativeArtifactInfo | null,
  ) => {
    if (options.json) {
      console.log(
        JSON.stringify({ ok: false, dryRun, artifact, problems, warnings }),
      );
    } else {
      for (const problem of problems) p.log.error(problem.message);
    }
    process.exitCode = 1;
  };
  const succeed = (
    artifact: NativeArtifactInfo,
    build: ImportableNativeBuild,
    nativeBuild: NativeBuildRow | null,
    alreadyImported: boolean,
  ) => {
    if (options.json) {
      console.log(
        JSON.stringify({
          ok: true,
          dryRun,
          alreadyImported,
          artifact,
          build,
          nativeBuild,
          warnings,
        }),
      );
    } else if (alreadyImported) {
      p.log.step(
        ui.line(["Already imported as native build", ui.id(nativeBuild!.id)]),
      );
    } else if (dryRun) {
      p.log.step("Dry run: the artifact can be imported; nothing was recorded");
    }
  };
  let workDir: string | undefined;
  try {
    const given = path.resolve(file);
    const stat = await fs.promises.stat(given).catch(() => null);
    let artifactPath: string;
    if (stat?.isDirectory() && given.endsWith(".app")) {
      // A simulator `.app` is read and stored as one zip archive.
      workDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "hot-updater-native-build-import-"),
      );
      artifactPath = path.join(workDir, `${path.basename(given)}.zip`);
      await archiveAppBundle({ appPath: given, outputPath: artifactPath });
    } else if (stat?.isFile()) {
      artifactPath = given;
    } else {
      throw new Error(`${file} is not a file or a simulator .app.`);
    }
    const byteSize = (await fs.promises.stat(artifactPath)).size;
    const config = await loadConfig(null);
    const source = blobSource(await fs.openAsBlob(artifactPath));
    let info: NativeArtifactInfo;
    try {
      info = await readNativeArtifact(source, path.basename(artifactPath));
    } catch (error) {
      if (error instanceof NativeArtifactError) {
        return fail([{ code: error.code, message: error.message }], null);
      }
      throw error;
    }
    if (!options.json) {
      p.log.step(
        describeArtifact(
          file,
          byteSize,
          info,
          config.updateStrategy,
          options.channel,
        ),
      );
    }
    const check = checkNativeArtifact(info, {
      updateStrategy: config.updateStrategy,
      appIds: declaredAppIds(config, info.platform),
      ...(options.channel === undefined ? {} : { channel: options.channel }),
    });
    warnings = check.warnings;
    for (const warning of warnings) {
      // Under --json, stdout stays the JSON line.
      if (options.json) console.error(warning.message);
      else p.log.warn(warning.message);
    }
    if (!check.ok) return fail(check.problems, info);
    const { build } = check;
    const scope: NativeBuildScope =
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
     * The registered build `build` is already, or a refusal of an artifact
     * whose MIN_BUNDLE_ID is taken otherwise, or undefined when it is free.
     */
    const registeredAs = async (): Promise<
      | { readonly nativeBuild: NativeBuildRow }
      | { readonly problem: NativeArtifactProblem }
      | undefined
    > => {
      // A fresh server each time: disposing one closes its database.
      const server = await loadServer(await loadConfig(null));
      try {
        const registered = await findRegistered(
          server.core,
          scope,
          build.minBundleId,
        );
        if (registered === undefined) return undefined;
        if (
          registered !== null &&
          (await isSameBuild(server, registered, build, source))
        ) {
          return { nativeBuild: registered };
        }
        return {
          problem: alreadyImportedProblem(
            build.minBundleId,
            registered?.id ?? null,
          ),
        };
      } finally {
        await safeDispose(server);
      }
    };
    const settle = (
      registered: NonNullable<Awaited<ReturnType<typeof registeredAs>>>,
    ) =>
      "nativeBuild" in registered
        ? succeed(info, build, registered.nativeBuild, true)
        : fail([registered.problem], info);

    const before = await registeredAs();
    if (before !== undefined) return settle(before);
    if (dryRun) return succeed(info, build, null, false);

    let nativeBuild: NativeBuildRow;
    try {
      nativeBuild = await registerNativeBuild(
        {
          platform: build.platform,
          minBundleId: build.minBundleId,
          channel: build.channel,
          ...(build.fingerprintHash === null
            ? { fingerprintHash: null, appVersion: build.appVersion! }
            : { fingerprintHash: build.fingerprintHash, appVersion: null }),
          artifactPath,
          artifactKind: build.kind,
          // Read from the artifact, as a build's own is: its
          // CFBundleVersion or versionCode.
          buildNumber: build.buildNumber,
        },
        {
          buildKey: null,
          // Built elsewhere, so this checkout's commit is not its own.
          gitCommitHash: null,
          writeBuiltInBundle: (outputPath) =>
            writeBuiltInBundle(source, build, outputPath),
        },
      );
    } catch (error) {
      // Another import won the write: the same build is imported, and
      // another is refused, as the check before would have.
      if (!isNativeBuildConflict(error)) throw error;
      const after = await registeredAs();
      if (after === undefined) throw error;
      return settle(after);
    }
    succeed(info, build, nativeBuild, false);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    if (workDir !== undefined) {
      await fs.promises.rm(workDir, { recursive: true, force: true });
    }
  }
};

/** Streams the built-in bundle the check found out of the artifact. */
const writeBuiltInBundle = async (
  source: ReturnType<typeof blobSource>,
  build: ImportableNativeBuild,
  outputPath: string,
) => {
  const entry = findZipEntry(
    await readZipDirectory(source),
    build.builtInBundlePath,
  );
  if (entry === undefined) {
    throw new Error(`The artifact has no ${build.builtInBundlePath}.`);
  }
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await pipeline(
    Readable.fromWeb(
      (await openZipEntry(source, entry)) as Parameters<
        typeof Readable.fromWeb
      >[0],
    ),
    fs.createWriteStream(outputPath),
  );
};
