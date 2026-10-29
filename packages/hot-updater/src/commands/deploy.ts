import fs from "fs";
import path from "path";

import {
  createTarBrTargetFiles,
  getCwd,
  HotUpdateDirUtil,
  type loadConfig,
  loadPlatformConfigs,
  INVALID_SIGNING_NEXT_STEP,
  ISSUE_SIGNING_KEY_COMMAND,
  p,
  prepareBundleSigning,
  PUT_SIGNING_KEY_COMMAND,
  putStorageFile,
  readBundleSigningState,
  UNSIGNED_BUNDLES_NEXT_STEP,
  UNSIGNED_BUNDLES_WARNING,
} from "@hot-updater/cli-tools";
import type {
  ConfiguredDatabase,
  HotUpdaterCoreApi,
  NativeBuildRow,
  NativeBuildScope,
  Platform,
  ReleaseCatalogMutationResult,
  StorageAdapter,
  StorageAdapterWith,
} from "@hot-updater/plugin-core";
import {
  assertStorageOperations,
  createBundleStorageKey,
  createStorageRootUriWithPath,
  targetBaseCandidateKey,
} from "@hot-updater/plugin-core";
import isPortReachable from "is-port-reachable";
import open from "open";
import { normalizeRange } from "verkit";

import { getPlatform } from "@/prompts/getPlatform";
import { createSignedFileHash } from "@/signedHashUtils";
import {
  createBundleManifest,
  writeBundleManifestFile,
} from "@/utils/bundleManifest";
import { createBundleDiff } from "@/utils/createBundleDiff";
import {
  appendFingerprintExtraSources,
  assertNativeSdkEmbedsFingerprint,
  describeFingerprintEngineChange,
  getFingerprintEngineChange,
  isFingerprintEquals,
  nativeFingerprint,
  readLocalFingerprint,
} from "@/utils/fingerprint";
import {
  getFingerprintDiff,
  showFingerprintDiff,
} from "@/utils/fingerprint/diff";
import {
  describeFingerprintReach,
  findOtherServedFingerprints,
} from "@/utils/fingerprint/reach";
import { getBundleZipTargets } from "@/utils/getBundleZipTargets";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { appendToProjectRootGitignore, getLatestGitCommit } from "@/utils/git";
import { loadServer } from "@/utils/loadServer";
import { printBanner } from "@/utils/printBanner";
import { validateSigningConfig } from "@/utils/signing/validateSigningConfig";
import { getDefaultTargetAppVersion } from "@/utils/version/getDefaultTargetAppVersion";
import { getNativeAppVersion } from "@/utils/version/getNativeAppVersion";

import { PLATFORMS } from "../commandOptions";
import { ui } from "../utils/cli-ui";
import {
  MANIFEST_ASSET_UPLOAD_CONCURRENCY,
  prepareContentAddressedAssetUploadTargets,
  type PreparedAssetUploadTarget,
  runWithConcurrency,
  uploadContentAddressedAsset,
} from "../utils/contentAddressedAssets";
import {
  formatAppVersionCandidates,
  isAmbiguousAppVersion,
} from "../utils/version/appVersionCandidates";
import { getConsolePort, openConsole, withConsoleSession } from "./console";
import {
  commitDeployment,
  type DeploymentWrite,
  prepareAndCommitBundles,
} from "./deployTransaction";

type DeployStorageAdapter = StorageAdapterWith<
  "put" | "get" | "exists" | "delete"
>;

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

/**
 * The built-in bundle of the newest native build registered for the
 * deploy's channel and platform, with its fingerprint or exact app version,
 * so a store install's first OTA arrives as a patch. Registration took its
 * file from the build's artifact, so the patch is made against the bytes
 * the build ships. One indexed read.
 */
const getBuiltInBaseBundleId = async ({
  bundleId,
  channel,
  core,
  platform,
  target,
}: {
  bundleId: string;
  channel: string;
  core: HotUpdaterCoreApi;
  platform: Platform;
  target: {
    appVersion: string | null;
    fingerprintHash: string | null;
  };
}): Promise<string | null> => {
  let scope: NativeBuildScope;
  if (target.fingerprintHash !== null) {
    scope = {
      platform,
      channel,
      fingerprintHash: target.fingerprintHash,
      appVersion: null,
    };
  } else if (target.appVersion !== null) {
    scope = {
      platform,
      channel,
      fingerprintHash: null,
      appVersion: target.appVersion,
    };
  } else {
    return null;
  }
  let nativeBuild: NativeBuildRow | null;
  try {
    nativeBuild = await core.findNativeBuild(scope);
  } catch (error) {
    // A self-hosted server without the native build routes answers 404: it
    // holds no native builds.
    if ((error as { status?: unknown } | null)?.status === 404) return null;
    throw error;
  }
  // A build made after this bundle runs it or a newer one.
  if (
    nativeBuild === null ||
    nativeBuild.min_bundle_id.localeCompare(bundleId) >= 0
  ) {
    return null;
  }
  return nativeBuild.min_bundle_id;
};

const createAutoPatches = async ({
  bundleId,
  channel,
  core,
  maxBaseBundles,
  platform,
  signingPublicKey,
  storageAdapter,
  target,
}: {
  bundleId: string;
  channel: string;
  core: HotUpdaterCoreApi;
  maxBaseBundles: number;
  platform: Platform;
  signingPublicKey: string | null;
  storageAdapter: DeployStorageAdapter;
  target: {
    appVersion: string | null;
    fingerprintHash: string | null;
  };
}) => {
  const releasedBaseBundleIds = await getPatchBaseBundleIds({
    bundleId,
    channel,
    core,
    maxBaseBundles,
    platform,
    target,
  });
  const failures: { baseBundleId: string; message: string }[] = [];
  let builtInBaseBundleId: string | null = null;
  try {
    builtInBaseBundleId = await getBuiltInBaseBundleId({
      bundleId,
      channel,
      core,
      platform,
      target,
    });
  } catch (error) {
    failures.push({
      baseBundleId: "built-in",
      message: error instanceof Error ? error.message : "Unknown patch error",
    });
  }
  // No release publishes a built-in bundle, so the catalog never names it.
  const baseBundleIds =
    builtInBaseBundleId === null
      ? releasedBaseBundleIds
      : [...releasedBaseBundleIds, builtInBaseBundleId];
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
          signingPublicKey,
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
    if (release === null || !release.bundle_id) {
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
    return ui.block("Deployment successful", [
      ui.kv("ID", ui.id(results[0]!.releaseId)),
    ]);
  }
  return ui.block(
    "Deployment successful",
    results.map((result) =>
      ui.kv(`${getPlatformName(result.platform)} ID`, ui.id(result.releaseId)),
    ),
  );
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
    prepareBundleSigning(config.signing, {
      cwd,
      secrets: config.secrets,
    }).catch((error: unknown) => {
      // As for a signing issue below: the E2E refusal check reads both.
      p.log.error(
        ui.prose(error instanceof Error ? error.message : String(error)),
      );
      p.log.error(
        "Deployment blocked. Fix the signing configuration and try again.",
      );
      return process.exit(1);
    }),
  ]);
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
    provider: buildAdapter.nativeBuild?.fingerprint,
  };

  // Validate signing configuration and the native key pinned by the app.
  const signingValidation = await validateSigningConfig(config, {
    expectedPublicKey: signingSession?.publicKey,
    platform,
    ...(getNativeSigningPublicKey === undefined
      ? {}
      : { nativePublicKey: nativeSigningPublicKey?.publicKey ?? null }),
  });

  if (signingValidation.issues.length > 0) {
    const errors = signingValidation.issues.filter((i) => i.type === "error");
    const warnings = signingValidation.issues.filter(
      (i) => i.type === "warning",
    );

    // Doctor's --json prints the same issues: only their layout is ours.
    for (const issue of errors) {
      p.log.error(`${ui.prose(issue.message)}\n${ui.prose(issue.resolution)}`);
    }
    if (errors.length > 0) {
      p.log.error(
        "Deployment blocked. Fix the signing configuration and try again.",
      );
      process.exit(1);
    }
    for (const warning of warnings) {
      p.log.warn(
        `${ui.prose(warning.message)}\n${ui.prose(warning.resolution)}`,
      );
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
    try {
      assertNativeSdkEmbedsFingerprint(cwd);
    } catch (error) {
      s.error(error instanceof Error ? error.message : String(error));
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

      const engineChange = getFingerprintEngineChange(
        projectFingerprint?.[platform],
        newFingerprint,
      );
      if (engineChange) {
        const { message, resolution } = describeFingerprintEngineChange(
          engineChange,
          platform === "ios" ? "iOS" : "Android",
        );
        p.log.warn(message);
        p.log.info(resolution);
      } else if (projectFingerprint?.[platform]) {
        // Show what changed
        try {
          const diff = await getFingerprintDiff(projectFingerprint[platform], {
            platform,
            ...fingerprintConfig,
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
    try {
      const reach = describeFingerprintReach({
        others: await findOtherServedFingerprints({
          core,
          channel: options.channel,
          platform,
          fingerprintHash: newFingerprint.hash,
        }),
        label: platform === "ios" ? "iOS" : "Android",
        channel: options.channel,
        fingerprintHash: newFingerprint.hash,
      });
      if (reach) p.log.warn(reach);
    } catch {
      // Reach is informational; the deploy doesn't depend on it.
    }
  } else {
    if (fs.existsSync(path.join(cwd, "fingerprint.json"))) {
      p.log.warn(
        [
          `fingerprint.json exists, but updateStrategy is '${config.updateStrategy}'.`,
          "Apps built here report the fingerprint strategy.",
          "Delete fingerprint.json, then rebuild the apps.",
        ].join("\n"),
      );
    }
    const defaultTargetAppVersion = options.targetAppVersion
      ? null
      : await getDefaultTargetAppVersion(platform);
    const ambiguousVersions =
      defaultTargetAppVersion && isAmbiguousAppVersion(defaultTargetAppVersion)
        ? formatAppVersionCandidates(defaultTargetAppVersion.candidates)
        : null;
    const defaultVersion = defaultTargetAppVersion?.version ?? null;

    const targetAppVersion =
      options.targetAppVersion ??
      (options.interactive
        ? await p.text({
            message: ambiguousVersions
              ? `Target app version (the native project builds several versions: ${ambiguousVersions})`
              : "Target app version",
            placeholder: defaultVersion ?? "1.0.0",
            initialValue: defaultVersion ?? (ambiguousVersions ? "" : "1.0.0"),
            validate: (value) => {
              if (!value || !normalizeRange(value)) {
                return "Invalid semver format (e.g. 1.0.0, 1.x.x)";
              }
              return;
            },
          })
        : defaultVersion);

    if (p.isCancel(targetAppVersion)) {
      return null;
    }

    if (!targetAppVersion) {
      p.log.error(
        ambiguousVersions
          ? `The native project builds several app versions:\n${ambiguousVersions}\nPass -t <targetAppVersion> for the app this deploy targets.`
          : "Target app version not found in Info.plist, project.pbxproj, build.gradle.\nPass -t <targetAppVersion>.",
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
      buildResult: {
        buildPath: string;
        bundleId: string;
        stdout: string | null;
      } | null;
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

          const manifest = await createBundleManifest({
            bundleId: currentBundleId,
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
            buildPath,
            manifest,
          });

          taskRef.assetUploadTargets = assetUploadTargets;
          taskRef.manifestPath = manifestPath;
          taskRef.archivePath = archivePath;

          manifestFileHash = await getFileHashFromFile(manifestPath);
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
              async (target) => {
                const uploaded = await uploadContentAddressedAsset(
                  storageAdapter,
                  taskRef.assetBaseStorageUri!,
                  target,
                );
                if (!uploaded) skippedUploadCount += 1;
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
                metadata: appVersion ? { app_version: appVersion } : {},
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
                  signingPublicKey: signingSession?.publicKey ?? null,
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
    process.exit(1);
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
  const signingStates = platformConfigs.map(({ config }) =>
    readBundleSigningState(config.signing),
  );
  // A value signing doesn't take, such as a removed signing adapter, never
  // deploys unsigned: refused before anything connects or builds.
  const refused = signingStates.find((state) => state.status === "invalid");
  if (refused?.status === "invalid") {
    p.log.error(
      [
        refused.message,
        ui.withCommand(INVALID_SIGNING_NEXT_STEP, PUT_SIGNING_KEY_COMMAND),
      ].join("\n"),
    );
    p.log.error(
      "Deployment blocked. Fix the signing configuration and try again.",
    );
    return process.exit(1);
  }
  // Once a run, however many platforms deploy unsigned. `enabled: false`
  // signs nothing on purpose, without the warning.
  if (signingStates.some((state) => state.status === "unsigned")) {
    p.log.warn(
      [
        UNSIGNED_BUNDLES_WARNING,
        ui.withCommand(UNSIGNED_BUNDLES_NEXT_STEP, ISSUE_SIGNING_KEY_COMMAND),
      ].join("\n"),
    );
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
    const storageAdapter = server.storage;
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
            await openConsole(port, ({ session }) => {
              void open(withConsoleSession(url, session));
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
