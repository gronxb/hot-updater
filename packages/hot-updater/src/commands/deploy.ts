import fs from "fs";
import path from "path";

import {
  createTarBrTargetFiles,
  createTarGzTargetFiles,
  createZipTargetFiles,
  getCwd,
  HotUpdateDirUtil,
  loadConfig,
  p,
} from "@hot-updater/cli-tools";
import type {
  Bundle,
  DatabasePlugin,
  Platform,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { createBundleDiff } from "@hot-updater/server";
import isPortReachable from "is-port-reachable";
import open from "open";
import semverValid from "semver/ranges/valid";

import { getPlatform } from "@/prompts/getPlatform";
import { createSignedFileHash } from "@/signedHashUtils";
import { writeBundleManifest } from "@/utils/bundleManifest";
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

import { getConsolePort, openConsole } from "./console";

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
    return 5;
  }

  if (
    !Number.isInteger(maxBaseBundles) ||
    maxBaseBundles < 1 ||
    maxBaseBundles > 5
  ) {
    throw new Error("Patch maxBaseBundles must be an integer between 1 and 5");
  }

  return maxBaseBundles;
};

const getPatchBaseBundles = async ({
  bundleId,
  channel,
  databasePlugin,
  maxBaseBundles,
  platform,
  target,
}: {
  bundleId: string;
  channel: string;
  databasePlugin: DatabasePlugin;
  maxBaseBundles: number;
  platform: Platform;
  target: {
    appVersion: string | null;
    fingerprintHash: string | null;
  };
}): Promise<Bundle[]> => {
  const where = {
    channel,
    enabled: true,
    id: { lt: bundleId },
    platform,
    ...(target.fingerprintHash
      ? {
          fingerprintHash: target.fingerprintHash,
        }
      : {
          targetAppVersion: target.appVersion,
          targetAppVersionNotNull: true,
        }),
  } satisfies Parameters<DatabasePlugin["getBundles"]>[0]["where"];
  const { data } = await databasePlugin.getBundles({
    limit: maxBaseBundles,
    orderBy: {
      direction: "desc",
      field: "id",
    },
    where,
  });

  return data
    .filter((bundle) => bundle.id !== bundleId)
    .slice(0, maxBaseBundles);
};

const createAutoPatches = async ({
  bundleId,
  channel,
  databasePlugin,
  maxBaseBundles,
  platform,
  storagePlugin,
  target,
}: {
  bundleId: string;
  channel: string;
  databasePlugin: DatabasePlugin;
  maxBaseBundles: number;
  platform: Platform;
  storagePlugin: StoragePlugin;
  target: {
    appVersion: string | null;
    fingerprintHash: string | null;
  };
}) => {
  const baseBundles = await getPatchBaseBundles({
    bundleId,
    channel,
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

const replaceStorageUriLeaf = (storageUri: string, nextLeaf: string) => {
  const storageUrl = new URL(storageUri);
  const normalizedPath = storageUrl.pathname.replace(/\/+$/, "");
  const lastSlashIndex = normalizedPath.lastIndexOf("/");
  const parentPath =
    lastSlashIndex >= 0 ? normalizedPath.slice(0, lastSlashIndex) : "";

  storageUrl.pathname = `${parentPath}/${nextLeaf}`;
  return storageUrl.toString();
};

const ensureUploadSourcePath = async ({
  outputPath,
  targetFile,
}: {
  outputPath: string;
  targetFile: { path: string; name: string };
}) => {
  const expectedFilename = path.posix.basename(targetFile.name);
  const actualFilename = path.basename(targetFile.path);

  if (expectedFilename === actualFilename) {
    return targetFile.path;
  }

  const aliasDir = path.join(
    outputPath,
    "upload-artifacts",
    getRelativeStorageDir(targetFile.name),
  );
  await fs.promises.mkdir(aliasDir, { recursive: true });

  const aliasPath = path.join(aliasDir, expectedFilename);
  await fs.promises.copyFile(targetFile.path, aliasPath);
  return aliasPath;
};

export const deploy = async (options: DeployOptions) => {
  printBanner();

  const cwd = getCwd();
  const rolloutPercentage = normalizeRolloutPercentage(options.rollout);
  const rolloutCohortCount =
    getRolloutCohortCountFromPercentage(rolloutPercentage);

  const gitCommit = await getLatestGitCommit();
  const [gitCommitHash, gitMessage] = [
    gitCommit?.id() ?? null,
    gitCommit?.summary() ?? null,
  ];

  const platform =
    options.platform ??
    (options.interactive
      ? await getPlatform("Which platform do you want to deploy?")
      : null);

  if (p.isCancel(platform)) {
    return;
  }

  if (!platform) {
    p.log.error(
      "Platform not found. -p <ios | android> or --platform <ios | android>",
    );
    return;
  }

  const channel = options.channel;

  const config = await loadConfig({ platform, channel });
  if (!config) {
    console.error("No config found. Please run `hot-updater init` first.");
    process.exit(1);
  }
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
    const defaultTargetAppVersion =
      (await getDefaultTargetAppVersion(platform)) ?? "1.0.0";

    const targetAppVersion =
      options.targetAppVersion ??
      (options.interactive
        ? await p.text({
            message: "Target app version",
            placeholder: defaultTargetAppVersion,
            initialValue: defaultTargetAppVersion,
            validate: (value) => {
              if (!semverValid(value)) {
                return "Invalid semver format (e.g. 1.0.0, 1.x.x)";
              }
              return;
            },
          })
        : null);

    if (p.isCancel(targetAppVersion)) {
      return;
    }

    if (!targetAppVersion) {
      p.log.error(
        "Target app version not found. -t <targetAppVersion> semver format (e.g. 1.0.0, 1.x.x)",
      );
      return;
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

  const deploymentContext = [
    `Channel: ${channel}`,
    `Rollout: ${rolloutPercentage}%`,
    config.updateStrategy === "fingerprint"
      ? `Fingerprint: ${target.fingerprintHash}`
      : `Target app version: ${semverValid(target.appVersion)}`,
  ].join("\n");

  p.note(deploymentContext, "Deployment");

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

  const normalizeOutputPath = path.isAbsolute(outputPath)
    ? outputPath
    : path.join(cwd, outputPath);

  const compressStrategy = config.compressStrategy;
  const bundleExtension = getExtensionFromCompressStrategy(compressStrategy);
  const bundlePath = path.join(
    normalizeOutputPath,
    "bundle",
    `bundle${bundleExtension}`,
  );

  const [buildPlugin, storagePlugin, databasePlugin] = await Promise.all([
    config.build({
      cwd,
    }),
    config.storage(),
    config.database(),
  ]);

  try {
    const taskRef: {
      buildResult: {
        buildPath: string;
        bundleId: string;
        stdout: string | null;
      } | null;
      targetFiles: { path: string; name: string }[];
      manifestPath: string | null;
      manifestStorageUri: string | null;
      assetBaseStorageUri: string | null;
      storageUri: string | null;
    } = {
      buildResult: null,
      targetFiles: [],
      manifestPath: null,
      manifestStorageUri: null,
      assetBaseStorageUri: null,
      storageUri: null,
    };

    await p.tasks([
      {
        title: `📦 Building Bundle (${buildPlugin.name})`,
        task: async () => {
          taskRef.buildResult = await buildPlugin.build({
            platform: platform,
          });

          await fs.promises.mkdir(normalizeOutputPath, { recursive: true });

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

          const { manifestPath } = await writeBundleManifest({
            buildPath,
            bundleId: currentBundleId,
            signFileHash: manifestSigning,
            targetFiles,
          });

          const bundleTargetFiles = [
            ...targetFiles,
            {
              path: manifestPath,
              name: "manifest.json",
            },
          ];
          taskRef.targetFiles = targetFiles;
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
      p.note(taskRef.buildResult.stdout.trim(), "Build Output");
    }

    if (config.signing?.enabled) {
      p.log.success("✅ Bundle Signing Complete");
    }

    await p.tasks([
      {
        title: `📦 Uploading to Storage (${storagePlugin.name})`,
        task: async () => {
          if (!bundleId) {
            throw new Error("Bundle ID not found");
          }

          try {
            const { storageUri } = await storagePlugin.upload(
              bundleId,
              bundlePath,
            );
            taskRef.storageUri = storageUri;

            if (!taskRef.manifestPath) {
              throw new Error("Manifest path not found");
            }

            const manifestUpload = await storagePlugin.upload(
              bundleId,
              taskRef.manifestPath,
            );
            taskRef.manifestStorageUri = manifestUpload.storageUri;
            taskRef.assetBaseStorageUri = replaceStorageUriLeaf(
              manifestUpload.storageUri,
              "files",
            );

            await Promise.all(
              taskRef.targetFiles.map(async (targetFile) => {
                const relativeDir = getRelativeStorageDir(targetFile.name);
                const uploadKey = [bundleId, "files", relativeDir]
                  .filter(Boolean)
                  .join("/");

                const uploadSourcePath = await ensureUploadSourcePath({
                  outputPath: normalizeOutputPath,
                  targetFile,
                });

                return storagePlugin.upload(uploadKey, uploadSourcePath);
              }),
            );
          } catch (e) {
            if (e instanceof Error) {
              p.log.error(e.message);
            }
            throw new Error("Failed to upload bundle to storage");
          }
          return `✅ Upload Complete (${storagePlugin.name})`;
        },
      },
      {
        title: `📦 Updating Database (${databasePlugin.name})`,
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
          const appVersion = await getNativeAppVersion(platform);

          try {
            await databasePlugin.appendBundle({
              shouldForceUpdate: options.forceUpdate,
              platform,
              fileHash,
              gitCommitHash,
              message: options?.message ?? gitMessage,
              id: bundleId,
              enabled: !options.disabled,
              channel,
              targetAppVersion: target.appVersion,
              fingerprintHash: target.fingerprintHash,
              storageUri: taskRef.storageUri,
              metadata: appVersion ? { app_version: appVersion } : {},
              assetBaseStorageUri: taskRef.assetBaseStorageUri,
              manifestFileHash,
              manifestStorageUri: taskRef.manifestStorageUri,
              rolloutCohortCount,
            });
            await databasePlugin.commitBundle();
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

    if (config.patch.enabled) {
      let patchSummary: {
        candidateCount: number;
        createdCount: number;
        failures: { baseBundleId: string; message: string }[];
      } | null = null;

      await p.tasks([
        {
          title: "⚡ Optimizing Delivery",
          task: async () => {
            try {
              patchSummary = await createAutoPatches({
                bundleId,
                channel,
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

      for (const failure of patchSummary?.failures ?? []) {
        p.log.warn(
          `Partial update skipped for ${failure.baseBundleId.slice(0, 8)}: ${failure.message}`,
        );
      }
    }

    if (options.interactive) {
      const port = await getConsolePort(config);
      const isConsoleOpen = await isPortReachable(port, { host: "localhost" });

      const openUrl = new URL(`http://localhost:${port}`);
      openUrl.searchParams.set("channel", channel);
      openUrl.searchParams.set("platform", platform);
      openUrl.searchParams.set("bundleId", bundleId);

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
    p.outro(`🚀 Deployment Successful (${bundleId})`);
  } catch (e) {
    await databasePlugin.onUnmount?.();
    await fs.promises.rm(bundlePath, { force: true });
    console.error(e);
    process.exit(1);
  } finally {
    await databasePlugin.onUnmount?.();
  }
};
