import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { createBrotliCompress, constants as zlibConstants } from "zlib";

import {
  createTarBrTargetFiles,
  getCwd,
  getStorageFileByteSize,
  HotUpdateDirUtil,
  type loadConfig,
  loadPlatformConfigs,
  p,
  prepareBundleSigning,
  putStorageFile,
} from "@hot-updater/cli-tools";
import type {
  BuildAdapter,
  BuildArtifact,
  ConfiguredDatabase,
  HotUpdaterCoreApi,
  Platform,
  ReleaseCatalogMutationResult,
  StorageAdapter,
  StorageAdapterWith,
} from "@hot-updater/plugin-core";
import {
  assertBundleArchiveByteSize,
  assertBundleExpandedByteSize,
  assertBundleTarStreamByteSize,
  assertStorageOperations,
  createBundleStorageKey,
  createStorageRootUriWithPath,
  createStorageUriWithRelativePath,
  getManifestAssetDownloadPath,
  getManifestAssetStoragePath,
  isContentAddressedAssetFileHash,
  targetBaseCandidateKey,
} from "@hot-updater/plugin-core";
import isPortReachable from "is-port-reachable";
import open from "open";
import { normalizeRange } from "verkit";

import { getPlatform } from "@/prompts/getPlatform";
import { createSignedFileHash } from "@/signedHashUtils";
import {
  createBundleManifest,
  type Manifest,
  writeBundleManifestFile,
} from "@/utils/bundleManifest";
import { createBundleDiff } from "@/utils/createBundleDiff";
import {
  appendFingerprintExtraSources,
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
import { loadServer, requireStorage } from "@/utils/loadServer";
import { printBanner } from "@/utils/printBanner";
import { validateSigningConfig } from "@/utils/signing/validateSigningConfig";
import { getDefaultTargetAppVersion } from "@/utils/version/getDefaultTargetAppVersion";
import { getNativeAppVersion } from "@/utils/version/getNativeAppVersion";

import { PLATFORMS } from "../commandOptions";
import { ui } from "../utils/cli-ui";
import { runIntegrationCommand } from "../utils/integration";
import { getConsolePort, openConsole } from "./console";
import {
  commitDeployment,
  type DeploymentWrite,
  prepareAndCommitBundles,
} from "./deployTransaction";

type DeployStorageAdapter = StorageAdapterWith<
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

class MultiPlatformStorageBoundaryError extends Error {
  override readonly name = "MultiPlatformStorageBoundaryError";

  constructor() {
    super(
      "Deploying multiple platforms requires a shared storage configuration.",
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
  readonly releaseId: string;
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

/**
 * Older bundles that enabled releases in the same channel and platform serve
 * to the new bundle's devices: the same fingerprint, or an app version range
 * that intersects the target's; newest release first, at most
 * `maxBaseBundles`. One point read of the scope's Release Catalog.
 */
const getPatchBaseBundleIds = async ({
  bundleId,
  channel,
  core,
  maxBaseBundles,
  platform,
  target,
}: {
  bundleId: string;
  channel: string;
  core: HotUpdaterCoreApi;
  maxBaseBundles: number;
  platform: Platform;
  target: {
    appVersion: string | null;
    fingerprintHash: string | null;
  };
}): Promise<string[]> => {
  const candidateKey = targetBaseCandidateKey({
    appVersion: target.appVersion,
    channel,
    fingerprintHash: target.fingerprintHash,
    platform,
  });
  if (candidateKey === null) return [];
  return core.findBaseBundleIds(candidateKey, bundleId, maxBaseBundles);
};

const createAutoPatches = async ({
  bundleId,
  channel,
  core,
  maxBaseBundles,
  platform,
  storageAdapter,
  target,
}: {
  bundleId: string;
  channel: string;
  core: HotUpdaterCoreApi;
  maxBaseBundles: number;
  platform: Platform;
  storageAdapter: DeployStorageAdapter;
  target: {
    appVersion: string | null;
    fingerprintHash: string | null;
  };
}) => {
  const baseBundleIds = await getPatchBaseBundleIds({
    bundleId,
    channel,
    core,
    maxBaseBundles,
    platform,
    target,
  });
  const failures: { baseBundleId: string; message: string }[] = [];
  let createdCount = 0;

  for (const baseBundleId of baseBundleIds) {
    try {
      await createBundleDiff(
        {
          baseBundleId,
          bundleId,
        },
        {
          core,
          storageAdapter,
        },
        {
          makePrimary: createdCount === 0,
        },
      );
      createdCount += 1;
    } catch (error) {
      failures.push({
        baseBundleId,
        message: error instanceof Error ? error.message : "Unknown patch error",
      });
    }
  }

  return {
    candidateCount: baseBundleIds.length,
    createdCount,
    failures,
  };
};

const getRelativeStorageDir = (relativePath: string) => {
  const normalized = relativePath.replace(/\\/g, "/");
  const dirname = path.posix.dirname(normalized);
  return dirname === "." ? "" : dirname;
};

type ManifestTargetFile = BuildArtifact;

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
  const uploadName = getManifestAssetDownloadPath(
    targetFile.name,
    targetFile.downloadCompression,
  );
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

    const downloadPath = getManifestAssetDownloadPath(
      targetFile.name,
      targetFile.downloadCompression,
    );
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
      const uploadName = getManifestAssetDownloadPath(
        targetFile.name,
        targetFile.downloadCompression,
      );
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
      releaseId: matched.releaseId,
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

const summarizeDeploymentResults = (
  results: readonly CommittedDeployPlatformResult[],
): string => {
  if (results.length === 1) {
    return [
      "Deployment successful",
      ui.kv("ID", ui.id(results[0]!.releaseId)),
    ].join("\n");
  }

  const labels = results.map(
    (result) => `${getPlatformName(result.platform)} ID:`,
  );
  const labelWidth = Math.max(...labels.map((label) => label.length));
  return [
    "Deployment successful",
    ...results.map(
      (result, index) =>
        `    ${labels[index]!.padEnd(labelWidth)} ${ui.id(result.releaseId)}`,
    ),
  ].join("\n");
};

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
  core,
  database,
  deferAutoPatches,
  options,
  persistDeployment,
  platform,
  platformIndex,
  platformCount,
  storageAdapter,
}: {
  config: DeployConfig;
  core: HotUpdaterCoreApi;
  database: ConfiguredDatabase;
  deferAutoPatches: boolean;
  /** Where bundles are uploaded: the config's storage. */
  storageAdapter: StorageAdapter;
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

  const [buildAdapter, signingSession] = await Promise.all([
    config.build({ cwd }),
    prepareBundleSigning(config.signing, { cwd }),
  ]);
  await runIntegrationCommand(config, "deploy", buildAdapter);
  const getNativeSigningPublicKey =
    buildAdapter.nativeBuild?.getBundleSigningPublicKey;
  const nativeSigningPublicKey = getNativeSigningPublicKey
    ? await getNativeSigningPublicKey()
    : undefined;
  const nativeFingerprintExtraSources =
    (await buildAdapter.nativeBuild?.getFingerprintExtraSources?.()) ?? [];
  const fingerprintConfig = {
    ...config.fingerprint,
    extraSources: appendFingerprintExtraSources(
      config.fingerprint.extraSources,
      nativeFingerprintExtraSources,
    ),
  };

  // Validate signing configuration and the native key pinned by the app.
  const signingValidation = await validateSigningConfig(config, {
    expectedPublicKey: signingSession?.publicKey,
    platform,
    ...(buildAdapter.nativeBuild?.signingConfigSource === undefined
      ? {}
      : { signingConfigSource: buildAdapter.nativeBuild.signingConfigSource }),
    ...(getNativeSigningPublicKey === undefined
      ? {}
      : { nativePublicKey: nativeSigningPublicKey?.publicKey ?? null }),
  });

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
      ...fingerprintConfig,
    });
    const projectFingerprint = await readLocalFingerprint();
    if (!isFingerprintEquals(newFingerprint, projectFingerprint?.[platform])) {
      s.error(
        "Fingerprint mismatch. 'hot-updater fingerprint create' to update fingerprint.json",
      );

      // Show what changed
      if (projectFingerprint?.[platform]) {
        try {
          const diff = getFingerprintDiff(
            projectFingerprint[platform],
            newFingerprint,
          );
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
  let manifestContentHash: string | null = null;
  let artifactSnapshotPath: string | null = null;
  let manifestFileHash: string | null = null;
  const platformName = getPlatformName(platform);
  const outputRoot = getBundleOutputRoot({
    cwd,
    outputPath,
    platform,
    multiPlatform,
  });

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

  assertStorageOperations(storageAdapter, ["put", "get", "exists", "delete"]);

  try {
    const taskRef: {
      buildResult: Awaited<ReturnType<BuildAdapter["build"]>> | null;
      assetUploadTargets: PreparedAssetUploadTarget[];
      manifestPath: string | null;
      archivePath: string | null;
      manifestStorageUri: string | null;
      assetBaseStorageUri: string | null;
    } = {
      buildResult: null,
      assetUploadTargets: [],
      manifestPath: null,
      archivePath: null,
      manifestStorageUri: null,
      assetBaseStorageUri: null,
    };

    await p.tasks([
      {
        title: `📦 Building Bundle (${platformName} • ${buildAdapter.name})`,
        task: async () => {
          taskRef.buildResult = await buildAdapter.build({
            platform: platform,
          });

          await fs.promises.mkdir(outputRoot, { recursive: true });

          const buildPath = taskRef.buildResult?.buildPath;
          if (!buildPath) {
            throw new Error("Build result not found");
          }
          const snapshot = await getBundleZipTargets(
            buildPath,
            taskRef.buildResult.artifacts,
          );
          artifactSnapshotPath = snapshot.path;
          const targetFiles = snapshot.artifacts;
          const currentBundleId = taskRef.buildResult.bundleId;
          bundleId = currentBundleId;

          const manifest = await createBundleManifest({
            bundleId: currentBundleId,
            patchAssetPath: taskRef.buildResult.patchAssetPath,
            signFileHash: signingSession?.signFileHash,
            targetFiles,
          });
          const assetUploadTargets =
            await prepareContentAddressedAssetUploadTargets({
              manifest,
              outputPath: outputRoot,
              targetFiles,
            });
          const archivePath = path.join(outputRoot, "bundle.tar.br");
          manifest.archive = await createTarBrTargetFiles({
            outfile: archivePath,
            targetFiles,
          });
          const manifestPath = await writeBundleManifestFile({
            buildPath: snapshot.path,
            manifest,
          });

          assertBundleArchiveByteSize(manifest.archive.downloadByteSize);
          assertBundleTarStreamByteSize(manifest.archive.tarByteSize);
          assertBundleExpandedByteSize(
            snapshot.expandedByteSize +
              (await fs.promises.stat(manifestPath)).size,
          );
          await fs.promises.chmod(manifestPath, 0o400);
          await fs.promises.chmod(snapshot.path, 0o500);
          taskRef.assetUploadTargets = assetUploadTargets;
          taskRef.manifestPath = manifestPath;
          taskRef.archivePath = archivePath;

          manifestContentHash = await getFileHashFromFile(manifestPath);
          manifestFileHash = manifestContentHash;
          if (signingSession) {
            const signature =
              await signingSession.signFileHash(manifestFileHash);
            manifestFileHash = createSignedFileHash(signature);
          }

          return `✅ Build Complete (${buildAdapter.name})`;
        },
      },
    ]);

    if (taskRef.buildResult?.stdout) {
      p.note(
        taskRef.buildResult.stdout.trim(),
        multiPlatform ? `Build Output (${platformName})` : "Build Output",
      );
    }

    if (signingSession) {
      p.log.success("✅ Bundle Signing Complete");
    }

    await p.tasks([
      {
        title: `📦 Uploading to Storage (${platformName} • ${storageAdapter.name})`,
        task: async (message = () => {}) => {
          if (!bundleId) {
            throw new Error("Build did not return an artifact ID");
          }
          if (!taskRef.manifestPath || !taskRef.archivePath) {
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
            await putStorageFile(
              storageAdapter,
              createBundleStorageKey(bundleId),
              taskRef.archivePath,
            );
            uploadedStepCount += 1;
            updateUploadProgress();
            const manifestUpload = await putStorageFile(
              storageAdapter,
              createBundleStorageKey(bundleId),
              taskRef.manifestPath,
            );
            taskRef.manifestStorageUri = manifestUpload.storageUri;
            uploadedStepCount += 1;
            updateUploadProgress();

            // /assets is a shared content-addressed root, not a per-bundle
            // directory. The server uses this suffix to derive asset object keys
            // from each manifest asset's transferred or logical file hash.
            taskRef.assetBaseStorageUri = createStorageRootUriWithPath(
              manifestUpload.storageUri,
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

                if ((await storageAdapter.exists({ storageUri })).exists) {
                  skippedUploadCount += 1;
                } else {
                  await putStorageFile(
                    storageAdapter,
                    uploadKey,
                    uploadSourcePath,
                  );
                }
                uploadedStepCount += 1;
                updateUploadProgress();
              },
            );
          } catch (e) {
            if (e instanceof Error) {
              p.log.error(e.message);
            }
            throw new Error("Failed to upload bundle to storage");
          }
          return `✅ Upload Complete (${storageAdapter.name}) • 100%`;
        },
      },
      {
        title: `📦 Updating Database (${platformName} • ${database.name})`,
        task: async () => {
          if (!bundleId) {
            throw new Error("Build did not return an artifact ID");
          }
          if (!manifestFileHash) {
            throw new Error("Manifest file hash not found");
          }
          const appVersion = await getNativeAppVersion(platform);

          try {
            await persistDeployment({
              bundle: {
                platform,
                gitCommitHash,
                id: bundleId,
                metadata: {
                  ...(appVersion ? { app_version: appVersion } : {}),
                  manifest_content_hash: manifestContentHash!,
                },
                assetBaseStorageUri: taskRef.assetBaseStorageUri!,
                manifestFileHash,
                manifestStorageUri: taskRef.manifestStorageUri!,
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
          return `✅ Update Complete (${database.name})`;
        },
      },
    ]);
    if (!bundleId) {
      throw new Error("Build did not return an artifact ID");
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
                  core,
                  maxBaseBundles: maxPatchBaseBundles,
                  platform,
                  storageAdapter,
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
            `Partial update skipped for file ${failure.baseBundleId.slice(0, 8)}: ${failure.message}`,
          );
        }
      };

      if (deferAutoPatches) {
        runDeferredPatches = runAutoPatches;
      } else {
        await runAutoPatches();
      }
    }

    return { bundleId: confirmedBundleId, platform, runDeferredPatches };
  } catch (e) {
    console.error(e);
    throw e;
  } finally {
    if (artifactSnapshotPath) {
      await fs.promises.chmod(artifactSnapshotPath, 0o700).catch(() => {});
      await fs.promises.rm(artifactSnapshotPath, {
        recursive: true,
        force: true,
      });
    }
  }
};

export const deploy = async (options: DeployOptions): Promise<void> => {
  printBanner();

  const platforms = await getDeployPlatforms(options);
  if (!platforms) {
    return;
  }
  // One load of the config file: a config object gives every platform the
  // same adapters, which the checks below compare.
  const platformConfigs = await loadPlatformConfigs(platforms, {
    channel: options.channel,
  });
  const firstPlatformConfig = platformConfigs[0];
  if (!firstPlatformConfig) {
    return;
  }
  // Every platform deploys through one server, assembled from the first
  // platform's config, so the configs must share one database. The ones a
  // refused deploy leaves unused are closed.
  const databases = new Set(
    platformConfigs.map(({ config }) => config.database),
  );
  if (databases.size > 1) {
    await Promise.all([...databases].map((database) => database?.dispose?.()));
    throw new MultiPlatformDatabaseBoundaryError();
  }
  // Every platform uploads to that server's storage, so they share it too.
  if (new Set(platformConfigs.map(({ config }) => config.storage)).size > 1) {
    await Promise.all([...databases].map((database) => database?.dispose?.()));
    throw new MultiPlatformStorageBoundaryError();
  }
  const server = await loadServer(firstPlatformConfig.config);
  const database = server.database;
  const core = server.core;

  const deployPlatforms = async (
    storageAdapter: StorageAdapter,
    persistDeployment: (input: DeploymentWrite) => Promise<void>,
  ): Promise<DeployPlatformResult[]> => {
    const preparedResults: DeployPlatformResult[] = [];
    for (const [
      platformIndex,
      { config, platform },
    ] of platformConfigs.entries()) {
      const result = await deployPlatform({
        config,
        core,
        database,
        deferAutoPatches: platforms.length > 1,
        options,
        persistDeployment,
        platform,
        platformCount: platforms.length,
        platformIndex,
        storageAdapter,
      });

      if (!result) {
        throw new DeployAbortedError();
      }

      preparedResults.push(result);
    }
    return preparedResults;
  };

  try {
    const storageAdapter = requireStorage(server);
    const rolloutPercentage = normalizeRolloutPercentage(options.rollout);
    // The schema fence (and a self-hosted server's admin protocol) is
    // checked before anything is built or uploaded.
    await core.ready();

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
        core,
        prepare: (persistDeployment) =>
          deployPlatforms(storageAdapter, persistDeployment),
      });
      preparedResults = committed.results;
      commitResults = committed.commitResults;
    } else {
      const committed: ReleaseCatalogMutationResult[] = [];
      preparedResults = await deployPlatforms(storageAdapter, async (input) => {
        committed.push(await commitDeployment({ core, ...input }));
      });
      commitResults = committed;
    }
    const results = resolveCommittedDeployments(preparedResults, commitResults);

    for (const [index, result] of results.entries()) {
      await result.runDeferredPatches?.();
      if (options.interactive) {
        const port = await getConsolePort(platformConfigs[index]!.config);
        const isConsoleOpen = await isPortReachable(port, {
          host: "localhost",
        });

        const openUrl = new URL(`http://localhost:${port}`);
        openUrl.searchParams.set("platform", result.platform);
        openUrl.searchParams.set("releaseId", result.releaseId);

        const url = openUrl.toString();

        const note = `Console: ${openUrl.origin}`;
        if (!isConsoleOpen) {
          const result = await p.confirm({
            message:
              "Console server is not running. Would you like to start it?",
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
    }

    p.outro(summarizeDeploymentResults(results));
  } catch (error) {
    if (!(error instanceof DeployAbortedError)) {
      throw error;
    }
  } finally {
    await server.dispose();
  }
};
