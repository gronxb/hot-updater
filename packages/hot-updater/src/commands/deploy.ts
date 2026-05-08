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
import type { Platform } from "@hot-updater/plugin-core";
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

import { PLATFORMS } from "../commandOptions";
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

const getPlatformName = (platform: Platform) =>
  platform === "ios" ? "iOS" : "Android";

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

const getMultiPlatformDeploymentContext = async ({
  channel,
  options,
  platforms,
  rolloutPercentage,
}: {
  channel: string;
  options: DeployOptions;
  platforms: Platform[];
  rolloutPercentage: number;
}) => {
  const config = await loadConfig({ platform: platforms[0]!, channel });
  if (!config) {
    return null;
  }

  const lines = [
    `Platform: Both (${platforms.map(getPlatformName).join(", ")})`,
    `Channel: ${channel}`,
    `Rollout: ${rolloutPercentage}%`,
  ];

  if (config.updateStrategy === "fingerprint") {
    lines.push("Fingerprint: per-platform");
  } else if (options.targetAppVersion) {
    lines.push(`Target app version: ${semverValid(options.targetAppVersion)}`);
  }

  return lines.join("\n");
};

const deployPlatform = async ({
  options,
  platform,
  platformIndex,
  platformCount,
}: {
  options: DeployOptions;
  platform: Platform;
  platformIndex: number;
  platformCount: number;
}): Promise<{ bundleId: string; platform: Platform } | null> => {
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
  const config = await loadConfig({ platform, channel });
  if (!config) {
    console.error("No config found. Please run `hot-updater init` first.");
    process.exit(1);
  }

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
              if (!semverValid(value)) {
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
      : `Target app version: ${semverValid(target.appVersion)}`,
  ].join("\n");

  const deploymentTitle = multiPlatform
    ? `Deployment (${platformName} ${platformIndex + 1}/${platformCount})`
    : "Deployment";

  if (multiPlatform) {
    p.log.step(`${deploymentTitle} • ${channel}`);
  } else {
    p.note(deploymentContext, deploymentTitle);
  }

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
      storageUri: string | null;
    } = {
      buildResult: null,
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

          const { manifestPath } = await writeBundleManifest({
            buildPath,
            bundleId: currentBundleId,
            targetFiles,
          });

          const bundleTargetFiles = [
            ...targetFiles,
            {
              path: manifestPath,
              name: "manifest.json",
            },
          ];

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
        title: `📦 Updating Database (${platformName} • ${databasePlugin.name})`,
        task: async () => {
          if (!bundleId) {
            throw new Error("Bundle ID not found");
          }
          if (!taskRef.storageUri) {
            throw new Error("Storage URI not found");
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
              metadata: appVersion
                ? {
                    app_version: appVersion,
                  }
                : {},
              rolloutCohortCount,
            });
            await databasePlugin.commitBundle();
          } catch (e) {
            if (e instanceof Error) {
              p.log.error(e.message);
            }
            throw e;
          }
          await databasePlugin.onUnmount?.();

          return `✅ Update Complete (${databasePlugin.name})`;
        },
      },
    ]);
    if (!bundleId) {
      throw new Error("Bundle ID not found");
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
    if (multiPlatform) {
      p.log.success(`✅ ${platformName} Deployment Successful (${bundleId})`);
      return { bundleId, platform };
    }

    p.outro(`🚀 Deployment Successful (${bundleId})`);
    return { bundleId, platform };
  } catch (e) {
    await databasePlugin.onUnmount?.();
    await fs.promises.rm(bundlePath, { force: true });
    console.error(e);
    process.exit(1);
  } finally {
    await databasePlugin.onUnmount?.();
  }
};

export const deploy = async (options: DeployOptions) => {
  printBanner();

  const platforms = await getDeployPlatforms(options);
  if (!platforms || platforms.length === 0) {
    return;
  }

  const rolloutPercentage = normalizeRolloutPercentage(options.rollout);

  if (platforms.length > 1) {
    const deploymentContext = await getMultiPlatformDeploymentContext({
      channel: options.channel,
      options,
      platforms,
      rolloutPercentage,
    });

    if (deploymentContext) {
      p.note(deploymentContext, "Deployment");
    }
  }

  const results: Array<{ bundleId: string; platform: Platform }> = [];
  for (const [platformIndex, platform] of platforms.entries()) {
    const result = await deployPlatform({
      options,
      platform,
      platformCount: platforms.length,
      platformIndex,
    });

    if (!result) {
      return;
    }

    results.push(result);
  }

  if (platforms.length > 1) {
    p.outro(
      `🚀 Deployment Successful (${results.map(({ platform }) => getPlatformName(platform)).join(", ")})`,
    );
  }
};
