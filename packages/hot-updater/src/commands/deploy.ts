import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { createBrotliCompress, constants as zlibConstants } from "zlib";

import {
  createTarBrTargetFiles,
  createTarGzTargetFiles,
  createZipTargetFiles,
  getCwd,
  getStorageFileByteSize,
  HotUpdateDirUtil,
  loadConfig,
  p,
  putStorageFile,
} from "@hot-updater/cli-tools";
import type {
  Bundle,
  BundleRepository,
  DatabaseMutationClient,
  Platform,
  ReleaseCatalogMutationResult,
  StoragePluginWith,
} from "@hot-updater/plugin-core";
import {
  assertStorageOperations,
  createBundleStorageKey,
  createDatabaseClient,
  createStorageRootUriWithPath,
  createStorageUriWithRelativePath,
  getManifestAssetDownloadPath,
  getManifestAssetStoragePath,
  isContentAddressedAssetFileHash,
} from "@hot-updater/plugin-core";
import { createBundleDiff } from "@hot-updater/server/db";
import isPortReachable from "is-port-reachable";
import open from "open";
import { normalizeRange, rangesIntersect } from "verkit";

import { getPlatform } from "@/prompts/getPlatform";
import { createSignedFileHash } from "@/signedHashUtils";
import {
  createBundleManifest,
  type Manifest,
  writeBundleManifestFile,
} from "@/utils/bundleManifest";
import {
  isFingerprintEquals,
  nativeFingerprint,
  readLocalFingerprint,
} from "@/utils/fingerprint";
import {
  getFingerprintDiff,
  showFingerprintDiff,
} from "@/utils/fingerprint/diff";
import { getBundleZipTargets } from "@/utils/getBundleZipTargets";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { appendToProjectRootGitignore, getLatestGitCommit } from "@/utils/git";
import { printBanner } from "@/utils/printBanner";
import { signBundle } from "@/utils/signing/bundleSigning";
import { validateSigningConfig } from "@/utils/signing/validateSigningConfig";
import { getDefaultTargetAppVersion } from "@/utils/version/getDefaultTargetAppVersion";
import { getNativeAppVersion } from "@/utils/version/getNativeAppVersion";

import { PLATFORMS } from "../commandOptions";
import { ui } from "../utils/cli-ui";
import { getConsolePort, openConsole } from "./console";
import {
  commitDeployment,
  type DeploymentWrite,
  prepareAndCommitBundles,
} from "./deployTransaction";

type DeployStoragePlugin = StoragePluginWith<
  "put" | "get" | "exists" | "delete"
>;

const MANIFEST_ASSET_UPLOAD_CONCURRENCY = 8;

class DeployAbortedError extends Error {
  override readonly name = "DeployAbortedError";
}

class MultiPlatformDatabaseBoundaryError extends Error {
  override readonly name = "MultiPlatformDatabaseBoundaryError";

  constructor() {
    super(
      "Deploying multiple platforms requires a shared database configuration.",
    );
  }
}

type DeployConfig = Awaited<ReturnType<typeof loadConfig>>;

type DeployPlatformResult = {
  readonly bundleId: string;
  readonly platform: Platform;
  readonly runDeferredPatches: (() => Promise<void>) | null;
};

type CommittedDeployPlatformResult = DeployPlatformResult & {
  readonly authorityId: string;
  readonly generation: number;
  readonly releaseId: string;
  readonly scopeKey: string;
};

export interface DeployOptions {
  bundleOutputPath?: string;
  channel: string;
  forceUpdate: boolean;
  interactive: boolean;
  message?: string;
  disabled?: boolean;
  platform?: Platform;
  rollout?: number;
  targetAppVersion?: string;
}

export const normalizeRolloutPercentage = (
  rollout: number | string | undefined,
): number => {
  if (rollout === undefined) {
    return 100;
  }

  const parsedRollout = typeof rollout === "number" ? rollout : Number(rollout);

  if (
    !Number.isInteger(parsedRollout) ||
    parsedRollout < 0 ||
    parsedRollout > 100
  ) {
    throw new Error("Rollout percentage must be an integer between 0 and 100");
  }

  return parsedRollout;
};

export const getRolloutCohortCountFromPercentage = (
  rolloutPercentage: number,
): number => {
  return rolloutPercentage * 10;
};

export const normalizePatchMaxBaseBundles = (
  maxBaseBundles: number | undefined,
): number => {
  if (maxBaseBundles === undefined) {
    return 3;
  }

  if (!Number.isInteger(maxBaseBundles) || maxBaseBundles < 1) {
    throw new Error("Patch maxBaseBundles must be a positive integer");
  }

  return maxBaseBundles;
};

const runWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
) => {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const itemIndex = nextIndex;
        nextIndex += 1;
        await task(items[itemIndex]!);
      }
    }),
  );
};

const formatUploadProgress = (
  completed: number,
  total: number,
  skipped = 0,
) => {
  const percent = total === 0 ? 100 : Math.round((completed / total) * 100);
  const skippedText = skipped > 0 ? `, skipped ${skipped}` : "";
  return `Uploading ${percent}% (${completed}/${total}${skippedText})`;
};

const areTargetAppVersionsPatchCompatible = (a: string, b: string): boolean => {
  const aRange = normalizeRange(a);
  const bRange = normalizeRange(b);

  if (!aRange || !bRange) {
    return false;
  }

  return rangesIntersect(aRange, bRange);
};

const getPatchBaseBundles = async ({
  bundleId,
  channel,
  database,
  databasePlugin,
  maxBaseBundles,
  platform,
  target,
}: {
  bundleId: string;
  channel: string;
  database: DatabaseMutationClient;
  databasePlugin: BundleRepository;
  maxBaseBundles: number;
  platform: Platform;
  target: {
    appVersion: string | null;
    fingerprintHash: string | null;
  };
}): Promise<Bundle[]> => {
  const channelRow = (
    await databasePlugin.models.channels.list({})
  ).channels.find(({ name }) => name === channel);
  if (channelRow === undefined) return [];
  const pageSize = Math.max(maxBaseBundles * 3, 10);
  const compatibleBundles: Bundle[] = [];
  const seenBundleIds = new Set<string>();
  let beforeReleaseId: string | undefined;

  while (compatibleBundles.length < maxBaseBundles) {
    const releases = await databasePlugin.models.releases.findMany({
      ...(beforeReleaseId === undefined ? {} : { beforeReleaseId }),
      channelId: channelRow.id,
      enabled: true,
      limit: pageSize,
      platform,
    });

    for (const release of releases) {
      const releaseIsCompatible = target.fingerprintHash
        ? release.strategy === "FINGERPRINT" &&
          release.fingerprint_hash === target.fingerprintHash
        : target.appVersion !== null &&
          release.strategy === "APP_VERSION" &&
          release.target_app_version !== null &&
          areTargetAppVersionsPatchCompatible(
            target.appVersion,
            release.target_app_version,
          );
      if (
        !releaseIsCompatible ||
        release.kind !== "BUNDLE" ||
        release.bundle_id === null ||
        release.bundle_id >= bundleId ||
        seenBundleIds.has(release.bundle_id)
      ) {
        continue;
      }
      seenBundleIds.add(release.bundle_id);
      const bundle = await database.getBundleById(release.bundle_id);
      if (bundle !== null) compatibleBundles.push(bundle);

      if (compatibleBundles.length >= maxBaseBundles) {
        break;
      }
    }

    if (releases.length < pageSize) break;
    const nextCursor = releases.at(-1)?.id;
    if (nextCursor === undefined || nextCursor === beforeReleaseId) break;
    beforeReleaseId = nextCursor;
  }

  return compatibleBundles;
};

const createAutoPatches = async ({
  bundleId,
  channel,
  database,
  databasePlugin,
  maxBaseBundles,
  platform,
  storagePlugin,
  target,
}: {
  bundleId: string;
  channel: string;
  database: DatabaseMutationClient;
  databasePlugin: BundleRepository;
  maxBaseBundles: number;
  platform: Platform;
  storagePlugin: DeployStoragePlugin;
  target: {
    appVersion: string | null;
    fingerprintHash: string | null;
  };
}) => {
  const baseBundles = await getPatchBaseBundles({
    bundleId,
    channel,
    database,
    databasePlugin,
    maxBaseBundles,
    platform,
    target,
  });
  const failures: { baseBundleId: string; message: string }[] = [];
  let createdCount = 0;

  for (const baseBundle of baseBundles) {
    try {
      await createBundleDiff(
        {
          baseBundleId: baseBundle.id,
          bundleId,
        },
        {
          databasePlugin,
          storagePlugin,
        },
        {
          makePrimary: createdCount === 0,
        },
      );
      createdCount += 1;
    } catch (error) {
      failures.push({
        baseBundleId: baseBundle.id,
        message: error instanceof Error ? error.message : "Unknown patch error",
      });
    }
  }

  return {
    candidateCount: baseBundles.length,
    createdCount,
    failures,
  };
};

const getExtensionFromCompressStrategy = (compressStrategy: string) => {
  switch (compressStrategy) {
    case "tar.br":
      return ".tar.br";
    case "tar.gz":
      return ".tar.gz";
    case "zip":
      return ".zip";
    default:
      throw new Error(`Unsupported compress strategy: ${compressStrategy}`);
  }
};

const getRelativeStorageDir = (relativePath: string) => {
  const normalized = relativePath.replace(/\\/g, "/");
  const dirname = path.posix.dirname(normalized);
  return dirname === "." ? "" : dirname;
};

type ManifestTargetFile = { path: string; name: string };

type PreparedAssetUploadTarget = {
  storagePath: string;
  uploadSourcePath: string;
};

const prepareManifestAssetUploadFile = async ({
  outputPath,
  targetFile,
}: {
  outputPath: string;
  targetFile: ManifestTargetFile;
}) => {
  const uploadName = getManifestAssetDownloadPath(targetFile.name);
  const expectedFilename = path.posix.basename(uploadName);
  const actualFilename = path.basename(targetFile.path);

  if (uploadName === targetFile.name && expectedFilename === actualFilename) {
    return targetFile.path;
  }

  const aliasDir = path.join(
    outputPath,
    "upload-artifacts",
    getRelativeStorageDir(uploadName),
  );
  await fs.promises.mkdir(aliasDir, { recursive: true });

  const aliasPath = path.join(aliasDir, expectedFilename);
  if (uploadName !== targetFile.name) {
    await pipeline(
      fs.createReadStream(targetFile.path),
      createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        },
      }),
      fs.createWriteStream(aliasPath),
    );
  } else {
    await fs.promises.copyFile(targetFile.path, aliasPath);
  }
  return aliasPath;
};

const prepareContentAddressedUploadFile = async ({
  outputPath,
  sourcePath,
  storagePath,
}: {
  outputPath: string;
  sourcePath: string;
  storagePath: string;
}) => {
  const filename = path.posix.basename(storagePath);
  if (path.basename(sourcePath) === filename) {
    return sourcePath;
  }

  const uploadPath = path.join(
    outputPath,
    "upload-artifacts",
    "content-addressed",
    filename,
  );
  await fs.promises.mkdir(path.dirname(uploadPath), { recursive: true });
  await fs.promises.copyFile(sourcePath, uploadPath);
  return uploadPath;
};

const prepareContentAddressedAssetUploadTargets = async ({
  manifest,
  outputPath,
  targetFiles,
}: {
  manifest: Manifest;
  outputPath: string;
  targetFiles: ManifestTargetFile[];
}) => {
  const candidates = new Map<
    string,
    {
      targetFile: ManifestTargetFile;
      targetNames: string[];
    }
  >();

  for (const targetFile of targetFiles) {
    const manifestAsset = manifest.assets[targetFile.name];
    if (!manifestAsset?.fileHash) {
      throw new Error(`Manifest file hash not found for ${targetFile.name}`);
    }

    const downloadPath = getManifestAssetDownloadPath(targetFile.name);
    const logicalStoragePath = getManifestAssetStoragePath({
      assetPath: downloadPath,
      fileHash: manifestAsset.fileHash,
    });
    const candidateKey = `${downloadPath === targetFile.name ? "raw" : "br"}:${logicalStoragePath}`;

    const candidate = candidates.get(candidateKey);
    if (candidate) {
      candidate.targetNames.push(targetFile.name);
    } else {
      candidates.set(candidateKey, {
        targetFile,
        targetNames: [targetFile.name],
      });
    }
  }

  const targets = new Map<string, PreparedAssetUploadTarget>();
  await runWithConcurrency(
    [...candidates.values()],
    MANIFEST_ASSET_UPLOAD_CONCURRENCY,
    async ({ targetFile, targetNames }) => {
      const uploadName = getManifestAssetDownloadPath(targetFile.name);
      const usesBrotli = uploadName !== targetFile.name;
      const preparedPath = await prepareManifestAssetUploadFile({
        outputPath,
        targetFile,
      });
      const downloadByteSize = await getStorageFileByteSize(preparedPath);
      const downloadFileHash = usesBrotli
        ? await getFileHashFromFile(preparedPath)
        : undefined;
      if (
        downloadFileHash !== undefined &&
        !isContentAddressedAssetFileHash(downloadFileHash)
      ) {
        throw new Error(
          `Prepared asset hash must be a lowercase SHA-256 hash: ${targetFile.name}`,
        );
      }

      const manifestAsset = manifest.assets[targetFile.name]!;
      const storagePath = getManifestAssetStoragePath({
        assetPath: uploadName,
        downloadFileHash,
        fileHash: manifestAsset.fileHash,
      });
      const uploadSourcePath = await prepareContentAddressedUploadFile({
        outputPath,
        sourcePath: preparedPath,
        storagePath,
      });

      for (const targetName of targetNames) {
        manifest.assets[targetName] = {
          ...manifest.assets[targetName]!,
          downloadByteSize,
          ...(downloadFileHash ? { downloadFileHash } : {}),
        };
      }
      targets.set(storagePath, { storagePath, uploadSourcePath });
    },
  );

  return [...targets.values()].sort((left, right) =>
    left.storagePath.localeCompare(right.storagePath),
  );
};

const getPlatformName = (platform: Platform) =>
  platform === "ios" ? "iOS" : "Android";

const resolveCommittedDeployments = (
  preparedResults: readonly DeployPlatformResult[],
  commitResults: readonly ReleaseCatalogMutationResult[],
): readonly CommittedDeployPlatformResult[] => {
  const commitsByBundleId = new Map<
    string,
    {
      readonly commit: ReleaseCatalogMutationResult;
      readonly releaseId: string;
    }
  >();

  for (const commit of commitResults) {
    const release = commit.release;
    if (release === null || release.kind !== "BUNDLE" || !release.bundle_id) {
      throw new Error(
        "Deployment commit result did not contain a Bundle Release.",
      );
    }
    if (commit.catalog.scope_key !== release.scope_key) {
      throw new Error(
        `Deployment commit result for Bundle ${release.bundle_id} has mismatched Release and Catalog scopes.`,
      );
    }
    if (commitsByBundleId.has(release.bundle_id)) {
      throw new Error(
        `Deployment commit returned duplicate results for Bundle ${release.bundle_id}.`,
      );
    }
    commitsByBundleId.set(release.bundle_id, {
      commit,
      releaseId: release.id,
    });
  }

  const results = preparedResults.map((prepared) => {
    const matched = commitsByBundleId.get(prepared.bundleId);
    if (!matched) {
      throw new Error(
        `Deployment commit did not return a Release for Bundle ${prepared.bundleId}.`,
      );
    }
    const release = matched.commit.release!;
    if (
      release.platform !== prepared.platform ||
      matched.commit.catalog.platform !== prepared.platform
    ) {
      throw new Error(
        `Deployment commit result for Bundle ${prepared.bundleId} has the wrong platform.`,
      );
    }
    commitsByBundleId.delete(prepared.bundleId);
    return {
      ...prepared,
      authorityId: matched.commit.catalog.authority_id,
      generation: matched.commit.catalog.generation,
      releaseId: matched.releaseId,
      scopeKey: matched.commit.catalog.scope_key,
    };
  });

  const unexpectedBundleId = commitsByBundleId.keys().next().value;
  if (unexpectedBundleId !== undefined) {
    throw new Error(
      `Deployment commit returned an unexpected result for Bundle ${unexpectedBundleId}.`,
    );
  }
  return results;
};

const summarizeDeploymentResult = (
  result: CommittedDeployPlatformResult,
): string =>
  ui.block(`${getPlatformName(result.platform)} Deployment`, [
    ui.kv("Release ID", ui.id(result.releaseId)),
    ui.kv("Bundle ID", ui.id(result.bundleId)),
    ui.kv("Authority ID", result.authorityId),
    ui.kv("Scope key", ui.code(result.scopeKey)),
    ui.kv("Generation", String(result.generation)),
  ]);

const getDeployPlatforms = async (
  options: DeployOptions,
): Promise<Platform[] | null> => {
  if (options.platform) {
    return [options.platform];
  }

  if (!options.interactive) {
    return [...PLATFORMS];
  }

  const platform = await getPlatform("Which platform do you want to deploy?");
  if (p.isCancel(platform)) {
    return null;
  }

  if (!platform) {
    p.log.error(
      "Platform not found. -p <ios | android> or --platform <ios | android>",
    );
    return null;
  }

  return [platform];
};

const getBundleOutputRoot = ({
  cwd,
  outputPath,
  platform,
  multiPlatform,
}: {
  cwd: string;
  outputPath: string;
  platform: Platform;
  multiPlatform: boolean;
}) => {
  const normalizedOutputPath = path.isAbsolute(outputPath)
    ? outputPath
    : path.join(cwd, outputPath);

  return multiPlatform
    ? path.join(normalizedOutputPath, platform)
    : normalizedOutputPath;
};

const getMultiPlatformDeploymentContext = ({
  config,
  options,
  platforms,
  rolloutPercentage,
}: {
  config: DeployConfig;
  options: DeployOptions;
  platforms: Platform[];
  rolloutPercentage: number;
}): string => {
  const lines = [
    `Platform: Both (${platforms.map(getPlatformName).join(", ")})`,
    `Channel: ${options.channel}`,
    `Rollout: ${rolloutPercentage}%`,
  ];

  if (config.updateStrategy === "fingerprint") {
    lines.push("Fingerprint: per-platform");
  } else if (options.targetAppVersion) {
    lines.push(
      `Target app version: ${normalizeRange(options.targetAppVersion)}`,
    );
  }

  return lines.join("\n");
};

const deployPlatform = async ({
  config,
  databasePlugin,
  deferAutoPatches,
  deferredDatabase,
  options,
  persistDeployment,
  platform,
  platformIndex,
  platformCount,
}: {
  config: DeployConfig;
  databasePlugin: BundleRepository;
  deferAutoPatches: boolean;
  deferredDatabase: DatabaseMutationClient;
  options: DeployOptions;
  persistDeployment: (input: DeploymentWrite) => Promise<void>;
  platform: Platform;
  platformIndex: number;
  platformCount: number;
}): Promise<DeployPlatformResult | null> => {
  const cwd = getCwd();
  const rolloutPercentage = normalizeRolloutPercentage(options.rollout);
  const rolloutCohortCount =
    getRolloutCohortCountFromPercentage(rolloutPercentage);
  const multiPlatform = platformCount > 1;

  const gitCommit = await getLatestGitCommit();
  const [gitCommitHash, gitMessage] = [
    gitCommit?.id() ?? null,
    gitCommit?.summary() ?? null,
  ];

  const channel = options.channel;
  const maxPatchBaseBundles = config.patch.enabled
    ? normalizePatchMaxBaseBundles(config.patch.maxBaseBundles)
    : 0;

  // Validate signing configuration
  const signingValidation = await validateSigningConfig(config);

  if (signingValidation.issues.length > 0) {
    const errors = signingValidation.issues.filter((i) => i.type === "error");
    const warnings = signingValidation.issues.filter(
      (i) => i.type === "warning",
    );

    if (errors.length > 0) {
      console.log("");
      p.log.error("Signing configuration error:");
      for (const issue of errors) {
        p.log.error(`  ${issue.message}`);
        p.log.info(`  Resolution: ${issue.resolution}`);
      }
      console.log("");
      p.log.error(
        "Deployment blocked. Fix the signing configuration and try again.",
      );
      process.exit(1);
    }

    if (warnings.length > 0) {
      console.log("");
      p.log.warn("Signing configuration warning:");
      for (const warning of warnings) {
        p.log.warn(`  ${warning.message}`);
        p.log.info(`  Resolution: ${warning.resolution}`);
      }
      console.log("");
    }
  }

  const target: {
    appVersion: string | null;
    fingerprintHash: string | null;
  } = {
    appVersion: null,
    fingerprintHash: null,
  };

  if (config.updateStrategy === "fingerprint") {
    const s = p.spinner();
    s.start(`Fingerprinting (${platform})`);
    if (!fs.existsSync(path.join(cwd, "fingerprint.json"))) {
      s.error(
        "Fingerprint.json not found. Please run 'hot-updater fingerprint create' to update fingerprint.json",
      );
      process.exit(1);
    }
    const newFingerprint = await nativeFingerprint(cwd, {
      platform,
      ...config.fingerprint,
    });
    const projectFingerprint = await readLocalFingerprint();
    if (!isFingerprintEquals(newFingerprint, projectFingerprint?.[platform])) {
      s.error(
        "Fingerprint mismatch. 'hot-updater fingerprint create' to update fingerprint.json",
      );

      // Show what changed
      if (projectFingerprint?.[platform]) {
        try {
          const diff = await getFingerprintDiff(projectFingerprint[platform], {
            platform,
            ...config.fingerprint,
          });
          showFingerprintDiff(diff, platform === "ios" ? "iOS" : "Android");
        } catch {
          p.log.warn("Could not generate fingerprint diff");
        }
      }

      process.exit(1);
    }

    target.fingerprintHash = newFingerprint.hash;
    s.stop(`Fingerprint(${platform}): ${newFingerprint.hash}`);
  } else {
    const defaultTargetAppVersion = await getDefaultTargetAppVersion(platform);

    const targetAppVersion =
      options.targetAppVersion ??
      (options.interactive
        ? await p.text({
            message: "Target app version",
            placeholder: defaultTargetAppVersion ?? "1.0.0",
            initialValue: defaultTargetAppVersion ?? "1.0.0",
            validate: (value) => {
              if (!value || !normalizeRange(value)) {
                return "Invalid semver format (e.g. 1.0.0, 1.x.x)";
              }
              return;
            },
          })
        : defaultTargetAppVersion);

    if (p.isCancel(targetAppVersion)) {
      return null;
    }

    if (!targetAppVersion) {
      p.log.error(
        "Target app version not found in native files (Info.plist for iOS, build.gradle for Android). Pass -t <targetAppVersion> explicitly, or check your native config.",
      );
      return null;
    }
    target.appVersion = targetAppVersion;
  }

  if (!target.fingerprintHash && !target.appVersion) {
    if (config.updateStrategy === "fingerprint") {
      p.log.error(
        "Fingerprint hash not found. Please run 'hot-updater fingerprint create' to update fingerprint.json",
      );
    } else {
      p.log.error(
        "Target app version not found. -t <targetAppVersion> semver format (e.g. 1.0.0, 1.x.x)",
      );
    }
    process.exit(1);
  }

  if (
    appendToProjectRootGitignore({
      globLines: [HotUpdateDirUtil.outputGitignorePath],
    })
  ) {
    p.log.info(".gitignore has been modified");
  }

  const outputPath =
    options.bundleOutputPath ?? HotUpdateDirUtil.getDefaultOutputPath({ cwd });

  let bundleId: string | null = null;
  let fileHash: string;
  let manifestFileHash: string | null = null;
  const platformName = getPlatformName(platform);
  const outputRoot = getBundleOutputRoot({
    cwd,
    outputPath,
    platform,
    multiPlatform,
  });

  const compressStrategy = config.compressStrategy;
  const bundleExtension = getExtensionFromCompressStrategy(compressStrategy);
  const bundlePath = path.join(
    outputRoot,
    "bundle",
    `bundle${bundleExtension}`,
  );

  const deploymentContext = [
    `Platform: ${platformName}`,
    `Channel: ${channel}`,
    `Rollout: ${rolloutPercentage}%`,
    config.updateStrategy === "fingerprint"
      ? `Fingerprint: ${target.fingerprintHash}`
      : `Target app version: ${
          target.appVersion && normalizeRange(target.appVersion)
        }`,
  ].join("\n");

  const deploymentTitle = multiPlatform
    ? `Deployment (${platformName} ${platformIndex + 1}/${platformCount})`
    : "Deployment";

  if (multiPlatform) {
    p.log.step(`${deploymentTitle} • ${channel}`);
  } else {
    p.note(deploymentContext, deploymentTitle);
  }

  const [buildPlugin, storagePlugin] = await Promise.all([
    config.build({
      cwd,
    }),
    config.storage,
  ]);
  assertStorageOperations(storagePlugin, ["put", "get", "exists", "delete"]);

  try {
    const taskRef: {
      buildResult: {
        buildPath: string;
        bundleId: string;
        stdout: string | null;
      } | null;
      assetUploadTargets: PreparedAssetUploadTarget[];
      archiveByteSize: number | null;
      manifestPath: string | null;
      manifestStorageUri: string | null;
      assetBaseStorageUri: string | null;
      storageUri: string | null;
    } = {
      buildResult: null,
      assetUploadTargets: [],
      archiveByteSize: null,
      manifestPath: null,
      manifestStorageUri: null,
      assetBaseStorageUri: null,
      storageUri: null,
    };

    await p.tasks([
      {
        title: `📦 Building Bundle (${platformName} • ${buildPlugin.name})`,
        task: async () => {
          taskRef.buildResult = await buildPlugin.build({
            platform: platform,
          });

          await fs.promises.mkdir(outputRoot, { recursive: true });

          const buildPath = taskRef.buildResult?.buildPath;
          if (!buildPath) {
            throw new Error("Build result not found");
          }
          const files = await fs.promises.readdir(buildPath, {
            recursive: true,
          });

          const targetFiles = await getBundleZipTargets(
            buildPath,
            files
              .filter(
                (file) =>
                  !fs.statSync(path.join(buildPath, file)).isDirectory(),
              )
              .map((file) => path.join(buildPath, file)),
          );
          const currentBundleId = taskRef.buildResult.bundleId;
          bundleId = currentBundleId;

          const manifestSigning =
            config.signing?.enabled && config.signing.privateKeyPath
              ? (assetFileHash: string) =>
                  signBundle(assetFileHash, config.signing!.privateKeyPath!)
              : undefined;

          const manifest = await createBundleManifest({
            bundleId: currentBundleId,
            signFileHash: manifestSigning,
            targetFiles,
          });
          const assetUploadTargets =
            await prepareContentAddressedAssetUploadTargets({
              manifest,
              outputPath: outputRoot,
              targetFiles,
            });
          const manifestPath = await writeBundleManifestFile({
            buildPath,
            manifest,
          });

          const bundleTargetFiles = [
            ...targetFiles,
            {
              path: manifestPath,
              name: "manifest.json",
            },
          ];
          taskRef.assetUploadTargets = assetUploadTargets;
          taskRef.manifestPath = manifestPath;

          switch (compressStrategy) {
            case "tar.br":
              await createTarBrTargetFiles({
                outfile: bundlePath,
                targetFiles: bundleTargetFiles,
              });
              break;
            case "tar.gz":
              await createTarGzTargetFiles({
                outfile: bundlePath,
                targetFiles: bundleTargetFiles,
              });
              break;
            case "zip":
              await createZipTargetFiles({
                outfile: bundlePath,
                targetFiles: bundleTargetFiles,
              });
              break;
            default:
              throw new Error(
                `Unsupported compression strategy: ${compressStrategy}`,
              );
          }
          fileHash = await getFileHashFromFile(bundlePath);

          // Sign bundle if signing is enabled
          if (config.signing?.enabled) {
            // Runtime validation: ensure privateKeyPath is provided when signing is enabled
            if (!config.signing.privateKeyPath) {
              throw new Error(
                "privateKeyPath is required when signing is enabled. " +
                  "Please provide a valid path to your RSA private key in hot-updater.config.ts",
              );
            }

            try {
              const signature = await signBundle(
                fileHash,
                config.signing.privateKeyPath,
              );
              // Store signature in signed format (sig:<signature>)
              // The hash is verified implicitly during signature verification
              fileHash = createSignedFileHash(signature);
            } catch (error) {
              p.log.error(`Signing error: ${(error as Error).message}`);
              p.log.error(
                "Ensure private key path is correct and file has proper permissions",
              );
              throw error;
            }
          }

          manifestFileHash = await getFileHashFromFile(manifestPath);
          if (config.signing?.enabled) {
            if (!config.signing.privateKeyPath) {
              throw new Error(
                "privateKeyPath is required when signing is enabled. " +
                  "Please provide a valid path to your RSA private key in hot-updater.config.ts",
              );
            }

            const signature = await signBundle(
              manifestFileHash,
              config.signing.privateKeyPath,
            );
            manifestFileHash = createSignedFileHash(signature);
          }

          return `✅ Build Complete (${buildPlugin.name})`;
        },
      },
    ]);

    if (taskRef.buildResult?.stdout) {
      p.note(
        taskRef.buildResult.stdout.trim(),
        multiPlatform ? `Build Output (${platformName})` : "Build Output",
      );
    }

    if (config.signing?.enabled) {
      p.log.success("✅ Bundle Signing Complete");
    }

    await p.tasks([
      {
        title: `📦 Uploading to Storage (${platformName} • ${storagePlugin.name})`,
        task: async (message = () => {}) => {
          if (!bundleId) {
            throw new Error("Bundle ID not found");
          }
          if (!taskRef.manifestPath) {
            throw new Error("Manifest path not found");
          }

          try {
            const assetUploadTargets = taskRef.assetUploadTargets;

            const uploadStepCount = assetUploadTargets.length + 2;
            let uploadedStepCount = 0;
            let skippedUploadCount = 0;
            const updateUploadProgress = () => {
              message(
                formatUploadProgress(
                  uploadedStepCount,
                  uploadStepCount,
                  skippedUploadCount,
                ),
              );
            };

            updateUploadProgress();
            const { byteSize, storageUri } = await putStorageFile(
              storagePlugin,
              createBundleStorageKey(bundleId),
              bundlePath,
            );
            taskRef.archiveByteSize = byteSize;
            taskRef.storageUri = storageUri;
            uploadedStepCount += 1;
            updateUploadProgress();

            // /assets is a shared content-addressed root, not a per-bundle
            // directory. The server uses this suffix to derive asset object keys
            // from each manifest asset's transferred or logical file hash.
            taskRef.assetBaseStorageUri = createStorageRootUriWithPath(
              storageUri,
              bundleId,
              "assets",
            );
            await runWithConcurrency(
              assetUploadTargets,
              MANIFEST_ASSET_UPLOAD_CONCURRENCY,
              async ({ storagePath, uploadSourcePath }) => {
                const storageUri = createStorageUriWithRelativePath({
                  baseStorageUri: taskRef.assetBaseStorageUri!,
                  relativePath: storagePath,
                });

                const relativeDir = getRelativeStorageDir(storagePath);
                const uploadKey = ["assets", relativeDir]
                  .filter(Boolean)
                  .join("/");

                if ((await storagePlugin.exists({ storageUri })).exists) {
                  skippedUploadCount += 1;
                } else {
                  await putStorageFile(
                    storagePlugin,
                    uploadKey,
                    uploadSourcePath,
                  );
                }
                uploadedStepCount += 1;
                updateUploadProgress();
              },
            );

            const manifestUpload = await putStorageFile(
              storagePlugin,
              createBundleStorageKey(bundleId),
              taskRef.manifestPath,
            );
            taskRef.manifestStorageUri = manifestUpload.storageUri;
            uploadedStepCount += 1;
            updateUploadProgress();
          } catch (e) {
            if (e instanceof Error) {
              p.log.error(e.message);
            }
            throw new Error("Failed to upload bundle to storage");
          }
          return `✅ Upload Complete (${storagePlugin.name}) • 100%`;
        },
      },
      {
        title: `📦 Updating Database (${platformName} • ${databasePlugin.name})`,
        task: async () => {
          if (!bundleId) {
            throw new Error("Bundle ID not found");
          }
          if (!taskRef.storageUri) {
            throw new Error("Storage URI not found");
          }
          if (!manifestFileHash) {
            throw new Error("Manifest file hash not found");
          }
          if (taskRef.archiveByteSize === null) {
            throw new Error("Bundle archive byte size not found");
          }
          const appVersion = await getNativeAppVersion(platform);

          try {
            await persistDeployment({
              authorityId: config.authorityId ?? "default",
              bundle: {
                platform,
                fileHash,
                gitCommitHash,
                id: bundleId,
                archiveByteSize: taskRef.archiveByteSize,
                storageUri: taskRef.storageUri,
                metadata: appVersion ? { app_version: appVersion } : {},
                assetBaseStorageUri: taskRef.assetBaseStorageUri,
                manifestFileHash,
                manifestStorageUri: taskRef.manifestStorageUri,
              },
              release: {
                channel,
                enabled: !options.disabled,
                fingerprintHash: target.fingerprintHash,
                message: options?.message ?? gitMessage,
                rolloutCohortCount,
                shouldForceUpdate: options.forceUpdate,
                targetAppVersion: target.appVersion,
              },
            });
          } catch (e) {
            if (e instanceof Error) {
              p.log.error(e.message);
            }
            throw e;
          }
          return `✅ Update Complete (${databasePlugin.name})`;
        },
      },
    ]);
    if (!bundleId) {
      throw new Error("Bundle ID not found");
    }
    const confirmedBundleId = bundleId;

    let runDeferredPatches: (() => Promise<void>) | null = null;
    if (config.patch.enabled) {
      const runAutoPatches = async (): Promise<void> => {
        let patchSummary: {
          candidateCount: number;
          createdCount: number;
          failures: { baseBundleId: string; message: string }[];
        } = {
          candidateCount: 0,
          createdCount: 0,
          failures: [],
        };

        await p.tasks([
          {
            title: "⚡ Optimizing Delivery",
            task: async () => {
              try {
                patchSummary = await createAutoPatches({
                  bundleId: confirmedBundleId,
                  channel,
                  database: deferredDatabase,
                  databasePlugin,
                  maxBaseBundles: maxPatchBaseBundles,
                  platform,
                  storagePlugin,
                  target,
                });
              } catch (error) {
                const message =
                  error instanceof Error
                    ? error.message
                    : "Unknown patch optimization error";
                p.log.warn(`Partial updates unavailable: ${message}`);
                patchSummary = {
                  candidateCount: 0,
                  createdCount: 0,
                  failures: [],
                };
              }

              if (!patchSummary.candidateCount) {
                return "Skipped (no compatible base bundles)";
              }

              if (!patchSummary.createdCount) {
                return "Skipped (no patch artifacts created)";
              }

              return `✅ Prepared ${patchSummary.createdCount} partial update path(s)`;
            },
          },
        ]);

        for (const failure of patchSummary.failures) {
          p.log.warn(
            `Partial update skipped for ${failure.baseBundleId.slice(0, 8)}: ${failure.message}`,
          );
        }
      };

      if (deferAutoPatches) {
        runDeferredPatches = runAutoPatches;
      } else {
        await runAutoPatches();
      }
    }

    if (options.interactive) {
      const port = await getConsolePort(config);
      const isConsoleOpen = await isPortReachable(port, { host: "localhost" });

      const openUrl = new URL(`http://localhost:${port}`);
      openUrl.searchParams.set("channel", channel);
      openUrl.searchParams.set("platform", platform);
      openUrl.searchParams.set("bundleId", confirmedBundleId);

      const url = openUrl.toString();

      const note = `Console: ${url}`;
      if (!isConsoleOpen) {
        const result = await p.confirm({
          message: "Console server is not running. Would you like to start it?",
          initialValue: false,
        });
        if (!p.isCancel(result) && result) {
          await openConsole(port, () => {
            void open(url);
          });
        }
      } else {
        void open(url);
      }

      p.note(note);
    }
    return { bundleId: confirmedBundleId, platform, runDeferredPatches };
  } catch (e) {
    await fs.promises.rm(bundlePath, { force: true });
    console.error(e);
    process.exit(1);
  }
};

export const deploy = async (options: DeployOptions): Promise<void> => {
  printBanner();

  const platforms = await getDeployPlatforms(options);
  if (!platforms) {
    return;
  }
  const platformConfigs = await Promise.all(
    platforms.map(async (platform) => ({
      config: await loadConfig({ channel: options.channel, platform }),
      platform,
    })),
  );
  const firstPlatformConfig = platformConfigs[0];
  if (!firstPlatformConfig) {
    return;
  }
  const databasePlugins = [
    ...new Set(platformConfigs.map(({ config }) => config.database)),
  ];
  const databasePlugin = firstPlatformConfig.config.database;
  const database = createDatabaseClient(databasePlugin);

  const deployPlatforms = async (
    persistDeployment: (input: DeploymentWrite) => Promise<void>,
  ): Promise<DeployPlatformResult[]> => {
    const preparedResults: DeployPlatformResult[] = [];
    for (const [
      platformIndex,
      { config, platform },
    ] of platformConfigs.entries()) {
      const result = await deployPlatform({
        config,
        databasePlugin,
        deferAutoPatches: platforms.length > 1,
        deferredDatabase: database,
        options,
        persistDeployment,
        platform,
        platformCount: platforms.length,
        platformIndex,
      });

      if (!result) {
        throw new DeployAbortedError();
      }

      preparedResults.push(result);
    }
    return preparedResults;
  };

  try {
    if (databasePlugins.length > 1) {
      throw new MultiPlatformDatabaseBoundaryError();
    }
    const rolloutPercentage = normalizeRolloutPercentage(options.rollout);

    if (platforms.length > 1) {
      p.note(
        getMultiPlatformDeploymentContext({
          config: firstPlatformConfig.config,
          options,
          platforms,
          rolloutPercentage,
        }),
        "Deployment",
      );
    }

    let preparedResults: readonly DeployPlatformResult[];
    let commitResults: readonly ReleaseCatalogMutationResult[];
    if (platforms.length > 1) {
      const committed = await prepareAndCommitBundles({
        database: databasePlugin,
        prepare: deployPlatforms,
      });
      preparedResults = committed.results;
      commitResults = committed.commitResults;
    } else {
      const committed: ReleaseCatalogMutationResult[] = [];
      preparedResults = await deployPlatforms(async (input) => {
        committed.push(
          await commitDeployment({ database: databasePlugin, ...input }),
        );
      });
      commitResults = committed;
    }
    const results = resolveCommittedDeployments(preparedResults, commitResults);

    for (const result of results) {
      await result.runDeferredPatches?.();
      p.log.message(summarizeDeploymentResult(result));
      if (platforms.length > 1) {
        p.log.success(
          `✅ ${getPlatformName(result.platform)} Deployment Successful (${result.bundleId})`,
        );
      }
    }

    if (platforms.length > 1) {
      p.outro(
        `🚀 Deployment Successful (${results.map(({ platform }) => getPlatformName(platform)).join(", ")})`,
      );
    } else {
      p.outro(`🚀 Deployment Successful (${results[0]!.bundleId})`);
    }
  } catch (error) {
    if (!(error instanceof DeployAbortedError)) {
      throw error;
    }
  } finally {
    await Promise.all(databasePlugins.map((plugin) => plugin.dispose?.()));
  }
};
