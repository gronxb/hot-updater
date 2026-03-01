import { getCwd, loadConfig, p } from "@hot-updater/cli-tools";
import type { IncrementalManifestEntry } from "@hot-updater/core";
import { HotUpdateDirUtil } from "@hot-updater/core";
import type { Platform } from "@hot-updater/plugin-core";
import fs from "fs";
import isPortReachable from "is-port-reachable";
import open from "open";
import path from "path";
import semverValid from "semver/ranges/valid";
import { getPlatform } from "@/prompts/getPlatform";
import { createSignedFileHash } from "@/signedHashUtils";
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
  targetAppVersion?: string;
}

type UploadManifestEntry = IncrementalManifestEntry & {
  storageUri: string;
};

type PreparedUploadTarget = {
  sourcePath: string;
  uploadPath: string;
  logicalPath: string;
  hash: string;
  size: number;
  kind: IncrementalManifestEntry["kind"];
};

const MAIN_BUNDLE_BY_PLATFORM: Record<Platform, string> = {
  ios: "index.ios.bundle",
  android: "index.android.bundle",
};

const normalizeRelativePathForFs = (relativePath: string): string => {
  return relativePath.split("/").join(path.sep);
};

export const deploy = async (options: DeployOptions) => {
  printBanner();

  const cwd = getCwd();

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
  p.log.step(`Channel: ${channel}`);

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
    p.log.info(`Target app version: ${semverValid(targetAppVersion)}`);

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
  let fileHash = "";

  const normalizeOutputPath = path.isAbsolute(outputPath)
    ? outputPath
    : path.join(cwd, outputPath);

  const ignoredCompressStrategy = config.compressStrategy;
  if (ignoredCompressStrategy) {
    p.log.info(
      `compressStrategy=${ignoredCompressStrategy} is ignored in deploy (OTA v2 uncompressed manifest mode).`,
    );
  }

  const [buildPlugin, storagePlugin, databasePlugin] = await Promise.all([
    config.build({
      cwd,
    }),
    config.storage(),
    config.database(),
  ]);

  const taskRef: {
    buildResult: {
      buildPath: string;
      bundleId: string;
      stdout: string | null;
    } | null;
    preparedTargets: PreparedUploadTarget[];
    manifest: UploadManifestEntry[];
    mainBundleHash: string | null;
    mainBundleStorageUri: string | null;
    uploadWorkDir: string | null;
  } = {
    buildResult: null,
    preparedTargets: [],
    manifest: [],
    mainBundleHash: null,
    mainBundleStorageUri: null,
    uploadWorkDir: null,
  };

  try {
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
          const filePaths: string[] = [];
          for (const relativePath of files) {
            const absolutePath = path.join(buildPath, relativePath);
            const stat = await fs.promises.stat(absolutePath);
            if (stat.isFile()) {
              filePaths.push(absolutePath);
            }
          }

          const targetFiles = await getBundleZipTargets(buildPath, filePaths);

          const mainBundlePath = MAIN_BUNDLE_BY_PLATFORM[platform];
          const preparedTargets: PreparedUploadTarget[] = [];

          for (const targetFile of targetFiles) {
            const stat = await fs.promises.stat(targetFile.path);
            const hash = await getFileHashFromFile(targetFile.path);
            const kind: IncrementalManifestEntry["kind"] =
              targetFile.name === mainBundlePath ? "bundle" : "asset";

            preparedTargets.push({
              sourcePath: targetFile.path,
              uploadPath: targetFile.path,
              logicalPath: targetFile.name,
              hash,
              size: stat.size,
              kind,
            });
          }

          bundleId = taskRef.buildResult.bundleId;
          taskRef.preparedTargets = preparedTargets;

          const mainTarget = preparedTargets.find(
            (targetFile) => targetFile.logicalPath === mainBundlePath,
          );
          if (!mainTarget) {
            throw new Error(
              `Main bundle file not found in build output: ${mainBundlePath}`,
            );
          }
          taskRef.mainBundleHash = mainTarget.hash;
          fileHash = mainTarget.hash;

          // Sign bundle if signing is enabled
          if (config.signing?.enabled) {
            // Runtime validation: ensure privateKeyPath is provided when signing is enabled
            if (!config.signing.privateKeyPath) {
              throw new Error(
                "privateKeyPath is required when signing is enabled. " +
                  "Please provide a valid path to your RSA private key in hot-updater.config.ts",
              );
            }

            const s = p.spinner();
            s.start("Signing bundle");

            try {
              const signature = await signBundle(
                fileHash,
                config.signing.privateKeyPath,
              );
              // Store signature in signed format (sig:<signature>)
              // The hash is verified implicitly during signature verification
              fileHash = createSignedFileHash(signature);
              s.stop("Bundle signed successfully");
            } catch (error) {
              s.error("Failed to sign bundle");
              p.log.error(`Signing error: ${(error as Error).message}`);
              p.log.error(
                "Ensure private key path is correct and file has proper permissions",
              );
              throw error;
            }
          }

          p.log.success(`Prepared ${preparedTargets.length} files for upload`);

          return `✅ Build Complete (${buildPlugin.name})`;
        },
      },
    ]);

    if (taskRef.buildResult?.stdout) {
      p.log.success(taskRef.buildResult.stdout);
    }

    await p.tasks([
      {
        title: `📦 Uploading to Storage (${storagePlugin.name})`,
        task: async () => {
          if (!bundleId) {
            throw new Error("Bundle ID not found");
          }
          if (!taskRef.mainBundleHash) {
            throw new Error("Main bundle hash not found");
          }
          if (taskRef.preparedTargets.length === 0) {
            throw new Error("Prepared target files not found");
          }

          const uploadWorkDir = path.join(
            normalizeOutputPath,
            ".upload-work",
            bundleId,
          );
          taskRef.uploadWorkDir = uploadWorkDir;
          await fs.promises.rm(uploadWorkDir, { recursive: true, force: true });
          await fs.promises.mkdir(uploadWorkDir, { recursive: true });

          const manifest: UploadManifestEntry[] = [];

          try {
            for (const preparedTarget of taskRef.preparedTargets) {
              const logicalBasename = path.posix.basename(
                preparedTarget.logicalPath,
              );
              const sourceBasename = path.basename(preparedTarget.sourcePath);
              let uploadPath = preparedTarget.sourcePath;

              if (sourceBasename !== logicalBasename) {
                const targetUploadPath = path.join(
                  uploadWorkDir,
                  normalizeRelativePathForFs(preparedTarget.logicalPath),
                );
                await fs.promises.mkdir(path.dirname(targetUploadPath), {
                  recursive: true,
                });
                await fs.promises.copyFile(
                  preparedTarget.sourcePath,
                  targetUploadPath,
                );
                uploadPath = targetUploadPath;
              }

              const relativeDir = path.posix.dirname(
                preparedTarget.logicalPath,
              );
              const storageKey =
                relativeDir === "." ? bundleId : `${bundleId}/${relativeDir}`;

              const { storageUri } = await storagePlugin.upload(
                storageKey,
                uploadPath,
              );

              manifest.push({
                path: preparedTarget.logicalPath,
                hash: preparedTarget.hash,
                size: preparedTarget.size,
                kind: preparedTarget.kind,
                storageUri,
              });

              if (preparedTarget.kind === "bundle") {
                taskRef.mainBundleStorageUri = storageUri;
              }
            }
          } catch (e) {
            if (e instanceof Error) {
              p.log.error(e.message);
            }
            throw new Error("Failed to upload files to storage");
          }

          taskRef.manifest = manifest;

          if (!taskRef.mainBundleStorageUri) {
            throw new Error("Main bundle storage URI not found after upload");
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
          if (!taskRef.mainBundleStorageUri) {
            throw new Error("Storage URI not found");
          }
          if (!taskRef.mainBundleHash) {
            throw new Error("Main bundle hash not found");
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
              storageUri: taskRef.mainBundleStorageUri,
              metadata: {
                ...(appVersion
                  ? {
                      app_version: appVersion,
                    }
                  : {}),
                incremental: {
                  bundleHash: taskRef.mainBundleHash,
                  manifest: taskRef.manifest.map(
                    ({ storageUri, ...rest }) => rest,
                  ),
                  patchCache: {},
                },
              },
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
    p.outro("🚀 Deployment Successful");
  } catch (e) {
    await databasePlugin.onUnmount?.();
    if (taskRef.uploadWorkDir) {
      await fs.promises.rm(taskRef.uploadWorkDir, {
        recursive: true,
        force: true,
      });
    }
    console.error(e);
    process.exit(1);
  } finally {
    if (taskRef.uploadWorkDir) {
      await fs.promises.rm(taskRef.uploadWorkDir, {
        recursive: true,
        force: true,
      });
    }
    await databasePlugin.onUnmount?.();
  }
};
