import fs from "fs/promises";

import open from "open";

import isPortReachable from "is-port-reachable";

import * as p from "@clack/prompts";

import { createZip } from "@/utils/createZip";

import { getDefaultTargetAppVersion } from "@/utils/getDefaultTargetAppVersion";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { getGitCommitHash, getLatestGitCommitMessage } from "@/utils/git";
import { type Platform, getCwd, loadConfig } from "@hot-updater/plugin-core";

import { getPlatform } from "@/prompts/getPlatform";

import { getConsolePort, openConsole } from "./console";

export interface DeployOptions {
  targetAppVersion?: string;
  platform?: Platform;
  forceUpdate: boolean;
  interactive: boolean;
}

export const deploy = async (options: DeployOptions) => {
  const config = await loadConfig();
  if (!config) {
    console.error("No config found. Please run `hot-updater init` first.");
    process.exit(1);
  }
  const cwd = getCwd();

  const [gitCommitHash, gitMessage] = await Promise.all([
    getGitCommitHash(),
    getLatestGitCommitMessage(),
  ]);

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

  const defaultTargetAppVersion =
    (await getDefaultTargetAppVersion(cwd, platform)) ?? "1.0.0";

  const targetAppVersion =
    options.targetAppVersion ??
    (options.interactive
      ? await p.text({
          message: "Target app version",
          placeholder: defaultTargetAppVersion,
          initialValue: defaultTargetAppVersion,
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

  let bundleId: string | null = null;
  let bundlePath: string;
  let fileUrl: string;
  let fileHash: string;

  const buildPlugin = config.build({
    cwd,
  });
  const storagePlugin = config.storage({
    cwd,
  });
  const databasePlugin = config.database({
    cwd,
  });

  try {
    await p.tasks([
      {
        title: `📦 Building Bundle (${buildPlugin.name})`,
        task: async () => {
          const buildResult = await buildPlugin.build({
            platform: platform,
          });
          await createZip(buildResult.buildPath, "build.zip");

          bundleId = buildResult.bundleId;
          bundlePath = buildResult.buildPath.concat(".zip");
          fileHash = await getFileHashFromFile(bundlePath);

          return `✅ Build Complete (${buildPlugin.name})`;
        },
      },
      {
        title: `📦 Uploading to Storage (${storagePlugin.name})`,
        task: async () => {
          if (!bundleId) {
            throw new Error("Bundle ID not found");
          }

          ({ fileUrl } = await storagePlugin.uploadBundle(
            bundleId,
            bundlePath,
          ));
          return `✅ Upload Complete (${storagePlugin.name})`;
        },
      },
      {
        title: `📦 Updating Database (${databasePlugin.name})`,
        task: async () => {
          if (!bundleId) {
            throw new Error("Bundle ID not found");
          }

          await databasePlugin.appendBundle({
            forceUpdate: options.forceUpdate,
            platform,
            fileUrl,
            fileHash,
            gitCommitHash,
            message: gitMessage,
            targetAppVersion,
            id: bundleId,
            enabled: true,
          });
          await databasePlugin.commitBundle();
          await databasePlugin.onUnmount?.();
          await fs.rm(bundlePath);

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

      const note = `Console: http://localhost:${port}/${bundleId}`;
      if (!isConsoleOpen) {
        const result = await p.confirm({
          message: "Console server is not running. Would you like to start it?",
          initialValue: false,
        });
        if (result) {
          await openConsole(port, () => {
            open(`http://localhost:${port}/${bundleId}`);
          });
        }
      } else {
        open(`http://localhost:${port}/${bundleId}`);
      }

      p.note(note);
    }
    p.outro("🚀 Deployment Successful");
  } catch (e) {
    await databasePlugin.onUnmount?.();
    console.error(e);
    process.exit(1);
  } finally {
    await databasePlugin.onUnmount?.();
  }
};
