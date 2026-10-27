import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import { loadConfig, p } from "@hot-updater/cli-tools";
import {
  DatabaseConstraintError,
  type HotUpdaterCoreApi,
  type NativeBuildRow,
  type NativeBuildScope,
} from "@hot-updater/plugin-core";
import {
  alreadyImportedProblem,
  blobSource,
  checkNativeArtifact,
  NativeArtifactError,
  openZipEntry,
  readNativeArtifact,
  readZipDirectory,
  type ImportableNativeBuild,
  type NativeArtifactInfo,
  type NativeArtifactProblem,
} from "@hot-updater/protocol/native-artifact";

import { ui } from "../utils/cli-ui";
import { formatBytes } from "../utils/formatBytes";
import { loadServer } from "../utils/loadServer";
import { registerNativeBuild } from "../utils/native/registerNativeBuild";
import { printBanner } from "../utils/printBanner";
import { safeDispose } from "./release";

export interface NativeBuildImportOptions {
  /** Reads and checks the artifact, and records nothing. */
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

/**
 * A registration the registry refused because its build or built-in bundle
 * exists: core's constraint error, or a self-hosted server's 409.
 */
const isConflict = (error: unknown) =>
  (error instanceof DatabaseConstraintError &&
    (error.reason === "unique" || error.reason === "exists")) ||
  (error as { status?: unknown } | null)?.status === 409;

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
      : Object.values(config.nativeBuild.android).map(
          (scheme) => scheme?.applicationId,
        );
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
};

const describeArtifact = (
  file: string,
  byteSize: number,
  info: NativeArtifactInfo,
  updateStrategy: "fingerprint" | "appVersion",
) => {
  const text = (value: NativeArtifactInfo["channel"]) =>
    value === null ? null : typeof value === "string" ? value : "unreadable";
  const lines = [
    ui.kv("File", ui.path(file)),
    ui.kv("Platform", ui.platform(info.platform)),
    ui.kv("Kind", info.kind),
    ui.kv("Size", formatBytes(byteSize)),
    ui.kv("App", info.appId ?? ui.muted("none")),
    ui.kv("App version", ui.version(text(info.appVersion) ?? "none")),
    ui.kv("Build number", info.buildNumber ?? ui.muted("none")),
    ui.kv(
      "Channel",
      info.channel === null
        ? `${ui.channel("production")} ${ui.muted("(none compiled in)")}`
        : ui.channel(text(info.channel)),
    ),
    ui.kv(
      "Min bundle ID",
      info.minBundleIdCandidates.length === 0
        ? ui.muted("none")
        : ui.id(info.minBundleIdCandidates.join(", ")),
    ),
  ];
  if (updateStrategy === "fingerprint") {
    lines.push(
      ui.kv(
        "Fingerprint",
        info.fingerprintCandidates.length === 0
          ? ui.muted("none")
          : ui.id(info.fingerprintCandidates.join(", ")),
      ),
    );
  }
  lines.push(
    ui.kv(
      "Built-in bundle",
      info.builtInBundle === null
        ? ui.muted("none")
        : `${info.builtInBundle.path} ${ui.muted(formatBytes(info.builtInBundle.byteSize))}`,
    ),
  );
  return ui.block("Native build artifact", lines);
};

/**
 * Imports a store artifact built elsewhere (EAS, Xcode Cloud, Fastlane, an
 * older build): an `.ipa`, `.aab` or `.apk`. It reads what the artifact
 * compiled in (platform, app version, channel, MIN_BUNDLE_ID, fingerprint)
 * and its built-in bundle, refuses an artifact that can't serve as a patch
 * base, then uploads the artifact and the built-in bundle and registers
 * them as `native-build ios|android` does after a build, so OTAs deployed
 * after it patch from its built-in bundle. With `--dry-run` it reads and
 * checks, and records nothing.
 */
export const handleNativeBuildImport = async (
  file: string,
  options: NativeBuildImportOptions,
) => {
  if (!options.json) printBanner();
  const fail = (
    problems: readonly NativeArtifactProblem[],
    artifact: NativeArtifactInfo | null,
  ) => {
    if (options.json) {
      console.log(
        JSON.stringify({
          ok: false,
          dryRun: options.dryRun ?? false,
          artifact,
          problems,
        }),
      );
    } else {
      for (const problem of problems) p.log.error(problem.message);
    }
    process.exitCode = 1;
  };
  try {
    const artifactPath = path.resolve(file);
    const stat = await fs.promises.stat(artifactPath).catch(() => null);
    if (stat === null || !stat.isFile()) {
      throw new Error(`${file} is not a file.`);
    }
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
      p.log.message(
        describeArtifact(file, stat.size, info, config.updateStrategy),
      );
    }
    const check = checkNativeArtifact(info, {
      updateStrategy: config.updateStrategy,
      appIds: declaredAppIds(config, info.platform),
    });
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

    const server = await loadServer(config);
    let registered: NativeBuildRow | null | undefined;
    try {
      registered = await findRegistered(server.core, scope, build.minBundleId);
    } finally {
      await safeDispose(server);
    }
    if (registered !== undefined) {
      return fail(
        [alreadyImportedProblem(build.minBundleId, registered?.id ?? null)],
        info,
      );
    }

    if (options.dryRun) {
      if (options.json) {
        console.log(
          JSON.stringify({
            ok: true,
            dryRun: true,
            artifact: info,
            build,
            nativeBuild: null,
          }),
        );
      } else {
        p.log.info(
          "Dry run: the artifact can be imported, and nothing was recorded.",
        );
      }
      return;
    }

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
      // Another import of the same build won the write: refuse it as one
      // the check found, naming the build.
      if (!isConflict(error)) throw error;
      const server = await loadServer(config);
      try {
        registered = await findRegistered(
          server.core,
          scope,
          build.minBundleId,
        );
      } finally {
        await safeDispose(server);
      }
      return fail(
        [alreadyImportedProblem(build.minBundleId, registered?.id ?? null)],
        info,
      );
    }
    if (options.json) {
      console.log(
        JSON.stringify({
          ok: true,
          dryRun: false,
          artifact: info,
          build,
          nativeBuild,
        }),
      );
    } else {
      p.log.info(
        "OTAs deployed from now on to its channel and target patch from its built-in bundle.",
      );
    }
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

/** Streams the built-in bundle the check found out of the artifact. */
const writeBuiltInBundle = async (
  source: ReturnType<typeof blobSource>,
  build: ImportableNativeBuild,
  outputPath: string,
) => {
  const entry = (await readZipDirectory(source)).find(
    ({ name }) => name === build.builtInBundlePath,
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
