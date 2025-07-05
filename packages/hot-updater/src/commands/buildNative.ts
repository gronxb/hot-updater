import fs from "fs";
import * as p from "@clack/prompts";
import { generateMinBundleId } from "@hot-updater/plugin-core";
import {
  type NativeBuild,
  type Platform,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";

import { getPlatform } from "@/prompts/getPlatform";

import path from "path";
import {
  createAndInjectFingerprintFiles,
  isFingerprintEquals,
  readLocalFingerprint,
} from "@/utils/fingerprint";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { runNativeBuild } from "@/utils/nativeBuild/runNativeBuild";
import { getDefaultOutputPath } from "@/utils/output/getDefaultOutputPath";
import { printBanner } from "@/utils/printBanner";
import { getNativeAppVersion } from "@/utils/version/getNativeAppVersion";
import { ExecaError } from "execa";
import picocolors from "picocolors";

export interface NativeBuildOptions {
  outputPath?: string;
  interactive: boolean;
  message?: string;
  platform?: Platform;
}

export const nativeBuild = async (options: NativeBuildOptions) => {
  printBanner();

  const cwd = getCwd();

  // const gitCommit = await getLatestGitCommit();
  // const [gitCommitHash, gitMessage] = [
  //   gitCommit?.id() ?? null,
  //   gitCommit?.summary() ?? null,
  // ];

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

  const config = await loadConfig({ platform, channel: /* todo */ "DUMMY" });
  if (!config) {
    console.error("No config found. Please run `hot-updater init` first.");
    process.exit(1);
  }

  const target: {
    appVersion: string | null;
    fingerprintHash: string | null;
  } = {
    appVersion: null,
    fingerprintHash: null,
  };

  // calculate fingerprint of the current file state in the native platform directory

  if (config.updateStrategy === "fingerprint") {
    const s = p.spinner();
    const localFingerprint = (await readLocalFingerprint())?.[platform];
    if (!localFingerprint) {
      p.log.warn(
        `Resolving fingerprint for ${platform} failed. Building native will generate it.`,
      );
    }
    s.start(`Fingerprinting (${platform})`);

    // generate fingerprint.json automatically
    const generatedFingerprint = (await createAndInjectFingerprintFiles())[
      platform
    ];

    s.stop(`Fingerprint(${platform}): ${generatedFingerprint}`);

    if (!isFingerprintEquals(localFingerprint, generatedFingerprint)) {
      p.log.info(
        `${picocolors.blue(`fingerprint.json, ${platform} fingerprint config files`)} have been changed.`,
      );
    }
    target.fingerprintHash = generatedFingerprint.hash;
  } else if (config.updateStrategy === "appVersion") {
    const s = p.spinner();
    s.start(`Get native app version (${platform})`);

    const appVersion = await getNativeAppVersion(platform);

    s.stop(`App Version(${platform}): ${appVersion}`);

    target.appVersion = appVersion;

    if (!target.appVersion) {
      p.log.error(`Failed to retrieve native app version of ${platform}`);
      return;
    }
  }

  // const nativeBuildConfig = config.nativeBuild;

  const artifactResultStorePath =
    options.outputPath ??
    path.join(
      getDefaultOutputPath(),
      "build",
      platform,
      platform === "android"
        ? config.nativeBuild.android.aab
          ? "aab"
          : "apk"
        : "",
    );

  const normalizeOutputPath = path.isAbsolute(artifactResultStorePath)
    ? artifactResultStorePath
    : path.join(cwd, artifactResultStorePath);

  // const artifactPath = path.join(normalizeOutputPath, platform);

  const [buildPlugin, storagePlugin, databasePlugin] = await Promise.all([
    config.build({
      cwd,
    }),
    config.storage({
      cwd,
    }),
    config.database({
      cwd,
    }),
  ]);

  let nativeBuildId: string | null = null;
  let fileHash: string | null = null;
  let fileSize: number | null = null;

  try {
    const taskRef: {
      buildResult: {
        stdout: string | null;
        buildDirectory: string | null;
        outputPath: string | null;
      };
      storageUri: string | null;
    } = {
      buildResult: { outputPath: null, stdout: null, buildDirectory: null },
      storageUri: null,
    };

    await p.tasks([
      {
        title: `📦 Building Native (${buildPlugin.name})`,
        task: async () => {
          await buildPlugin.nativeBuild?.prebuild?.({ platform });
          const { buildDirectory, outputFile } = await runNativeBuild({
            platform,
            config: config.nativeBuild,
          });
          taskRef.buildResult.outputPath = outputFile;
          taskRef.buildResult.buildDirectory = buildDirectory;

          await buildPlugin.nativeBuild?.postbuild?.({ platform });

          await fs.promises.mkdir(normalizeOutputPath, { recursive: true });

          p.log.success(
            `Artifact stored at ${picocolors.blueBright(path.relative(getCwd(), artifactResultStorePath))}.`,
          );

          await fs.promises.rm(artifactResultStorePath, {
            recursive: true,
            force: true,
          });
          await fs.promises.cp(
            taskRef.buildResult.buildDirectory!,
            artifactResultStorePath,
            { recursive: true },
          );

          // Find the actual build artifact file
          const files = await fs.promises.readdir(artifactResultStorePath, {
            recursive: true,
          });

          const artifactFiles = files.filter((file) => {
            const fullPath = path.join(artifactResultStorePath, file);
            const stat = fs.statSync(fullPath);
            return (
              !stat.isDirectory() &&
              (file.endsWith(".apk") ||
                file.endsWith(".aab") ||
                file.endsWith(".ipa"))
            );
          });

          if (artifactFiles.length === 0) {
            throw new Error("No native build artifact found");
          }

          const artifactFile = artifactFiles[0];
          if (!artifactResultStorePath)
            throw new Error("Artifact result store path is required");
          if (!artifactFile) throw new Error("Artifact file is required");
          const fullArtifactPath = path.join(
            artifactResultStorePath,
            artifactFile,
          );

          // Generate native build ID (this will be the minBundleId)
          nativeBuildId = generateMinBundleId();

          // Calculate file hash and size
          fileHash = await getFileHashFromFile(fullArtifactPath);
          const stat = await fs.promises.stat(fullArtifactPath);
          fileSize = stat.size;

          return `Build Complete (${buildPlugin.name})`;
        },
      },
    ]);
    if (taskRef.buildResult.stdout) {
      p.log.success(taskRef.buildResult.stdout);
    }

    // Find the actual artifact file for upload
    const files = await fs.promises.readdir(artifactResultStorePath, {
      recursive: true,
    });

    const artifactFiles = files.filter((file) => {
      const fullPath = path.join(artifactResultStorePath, file);
      const stat = fs.statSync(fullPath);
      return (
        !stat.isDirectory() &&
        (file.endsWith(".apk") ||
          file.endsWith(".aab") ||
          file.endsWith(".ipa"))
      );
    });

    if (artifactFiles.length === 0) {
      throw new Error("No native build artifact found for upload");
    }

    const artifactFile = artifactFiles[0];
    if (!artifactResultStorePath)
      throw new Error("Artifact result store path is required");
    if (!artifactFile) throw new Error("Artifact file is required");
    const fullArtifactPath = path.join(artifactResultStorePath, artifactFile);

    await p.tasks([
      {
        title: `📦 Uploading to Storage (${storagePlugin.name})`,
        task: async () => {
          if (!nativeBuildId) {
            throw new Error("Native build ID not found");
          }

          try {
            const { storageUri } = await storagePlugin.uploadNativeBuild(
              nativeBuildId,
              fullArtifactPath,
            );
            taskRef.storageUri = storageUri;
          } catch (e) {
            if (e instanceof Error) {
              p.log.error(e.message);
            }
            throw new Error("Failed to upload native build to storage");
          }
          return `✅ Upload Complete (${storagePlugin.name})`;
        },
      },
      {
        title: `📦 Updating Database (${databasePlugin.name})`,
        task: async () => {
          if (!nativeBuildId) {
            throw new Error("Native build ID not found");
          }
          if (!taskRef.storageUri) {
            throw new Error("Storage URI not found");
          }
          if (!fileHash || !fileSize) {
            throw new Error("File hash or size not calculated");
          }

          const appVersion = await getNativeAppVersion(platform);

          try {
            const nativeBuild: NativeBuild = {
              id: nativeBuildId,
              nativeVersion: appVersion || "unknown",
              platform,
              fingerprintHash: target.fingerprintHash || "",
              storageUri: taskRef.storageUri,
              fileHash,
              fileSize,
              channel: "production", // Default channel for native builds
              metadata: {
                ...(options.message ? { message: options.message } : {}),
                targetAppVersion: target.appVersion,
              },
            };

            await databasePlugin.appendNativeBuild(nativeBuild);
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

    if (!nativeBuildId) {
      throw new Error("Native build ID not found");
    }

    p.outro("🚀 Native Build Successful");
    p.log.info(`Native Build ID (minBundleId): ${nativeBuildId}`);
    p.log.info(`Platform: ${platform}`);
    p.log.info(`Fingerprint: ${target.fingerprintHash || "N/A"}`);
    p.log.info(`App Version: ${target.appVersion || "N/A"}`);
    p.log.info(`File Hash: ${fileHash}`);
    p.log.info(`File Size: ${fileSize} bytes`);
    p.log.info(`Storage URI: ${taskRef.storageUri}`);
    p.log.info(
      `Artifact stored locally at: ${picocolors.blueBright(path.relative(getCwd(), artifactResultStorePath))}`,
    );
  } catch (e) {
    await databasePlugin.onUnmount?.();
    await fs.promises.rm(artifactResultStorePath, {
      force: true,
      recursive: true,
    });
    if (e instanceof ExecaError) {
      console.error(e);
    } else if (e instanceof Error) {
      p.log.error(e.stack ?? e.message);
    } else {
      console.error(e);
    }
    process.exit(1);
  } finally {
    await databasePlugin.onUnmount?.();
  }
};
