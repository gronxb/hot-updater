import fs from "fs";
import semverValid from "semver/ranges/valid";

import open from "open";

import isPortReachable from "is-port-reachable";

import * as p from "@clack/prompts";

import { getDefaultTargetAppVersion } from "@/utils/getDefaultTargetAppVersion";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { getLatestGitCommit } from "@/utils/git";
import {
  type Platform,
  createZipTargetFiles,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";

import { getPlatform } from "@/prompts/getPlatform";

import { getConsolePort, openConsole } from "./console";

import path from "path";
import { getBundleZipTargets } from "@/utils/getBundleZipTargets";
import { printBanner } from "@/utils/printBanner";
import { nativeFingerprint } from "@rnef/tools";

export interface DeployOptions {
  bundleOutputPath?: string;
  channel: string;
  forceUpdate: boolean;
  interactive: boolean;
  message?: string;
  platform?: Platform;
  targetAppVersion?: string;
}

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

  const target: {
    appVersion: string | null;
    fingerprintHash: string | null;
  } = {
    appVersion: null,
    fingerprintHash: null,
  };

  if (config.updateStrategy === "fingerprint") {
    const fingerprint = await nativeFingerprint(cwd, {
      platform,
      ...config.fingerprint,
    });
    const projectFingerprintJsonFile = fs.readFileSync(
      path.join(cwd, "fingerprint.json"),
      "utf-8",
    );

    const projectFingerprint = JSON.parse(projectFingerprintJsonFile);
    if (fingerprint.hash !== projectFingerprint[platform].hash) {
      p.log.error(
        "Fingerprint mismatch. 'hot-updater fingerprint create' to update fingerprint.json",
      );
      process.exit(1);
    }

    target.fingerprintHash = fingerprint.hash;
  } else {
    const defaultTargetAppVersion =
      (await getDefaultTargetAppVersion(cwd, platform)) ?? "1.0.0";

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

  const outputPath = options.bundleOutputPath ?? cwd;

  let bundleId: string | null = null;
  let fileHash: string;

  const normalizeOutputPath = path.isAbsolute(outputPath)
    ? outputPath
    : path.join(cwd, outputPath);

  const bundlePath = path.join(normalizeOutputPath, "bundle.zip");

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

    p.log.info(`Channel: ${channel}`);

    await p.tasks([
      {
        title: `📦 Building Bundle (${buildPlugin.name})`,
        task: async () => {
          taskRef.buildResult = await buildPlugin.build({
            platform: platform,
            channel,
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
          await createZipTargetFiles({
            outfile: bundlePath,
            targetFiles: targetFiles,
          });

          bundleId = taskRef.buildResult.bundleId;
          fileHash = await getFileHashFromFile(bundlePath);

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

          try {
            const { storageUri } = await storagePlugin.uploadBundle(
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
        title: `📦 Updating Database (${databasePlugin.name})`,
        task: async () => {
          if (!bundleId || !taskRef.storageUri) {
            throw new Error("Bundle ID not found");
          }

          try {
            await databasePlugin.appendBundle({
              shouldForceUpdate: options.forceUpdate,
              platform,
              fileHash,
              gitCommitHash,
              message: options?.message ?? gitMessage,
              id: bundleId,
              enabled: true,
              channel,
              targetAppVersion: target.appVersion,
              fingerprintHash: target.fingerprintHash,
              storageUri: taskRef.storageUri,
            });
            await databasePlugin.commitBundle();
          } catch (e) {
            if (e instanceof Error) {
              p.log.error(e.message);
            }
            throw new Error("Failed to update database");
          }
          await databasePlugin.onUnmount?.();
          await fs.promises.rm(bundlePath);

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
            open(url);
          });
        }
      } else {
        open(url);
      }

      p.note(note);
    }
    p.outro("🚀 Deployment Successful");
  } catch (e) {
    await databasePlugin.onUnmount?.();
    await fs.promises.rm(bundlePath, { force: true });
    console.error(e);
    process.exit(1);
  } finally {
    await databasePlugin.onUnmount?.();
    await fs.promises.rm(bundlePath, { force: true });
  }
};
