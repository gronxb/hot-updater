import fs from "fs/promises";
import semverValid from "semver/ranges/valid";

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

import path from "path";
import { printBanner } from "@/components/banner";

export interface DeployOptions {
  targetAppVersion?: string;
  platform?: Platform;
  forceUpdate: boolean;
  interactive: boolean;
}

export const deploy = async (options: DeployOptions) => {
  printBanner();
  
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

  const config = await loadConfig(platform);
  if (!config) {
    console.error("No config found. Please run `code-updater init` first.");
    process.exit(1);
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

  let bundleId: string | null = null;
  let bundlePath: string;
  let fileUrl: string;
  let fileHash: string;

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
    } = {
      buildResult: null,
    };

    await p.tasks([
      {
        title: `📦 Building Bundle (${buildPlugin.name})`,
        task: async () => {
          taskRef.buildResult = await buildPlugin.build({
            platform: platform,
          });
          await createZip(taskRef.buildResult.buildPath, "bundle.zip");

          bundleId = taskRef.buildResult.bundleId;
          bundlePath = path.join(getCwd(), "bundle.zip");
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
            ({ fileUrl } = await storagePlugin.uploadBundle(
              bundleId,
              bundlePath,
            ));
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

          try {
            await databasePlugin.appendBundle({
              shouldForceUpdate: options.forceUpdate,
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
          } catch (e) {
            if (e instanceof Error) {
              p.log.error(e.message);
            }
            throw new Error("Failed to update database");
          }
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
