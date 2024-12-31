import fs from "node:fs/promises";
import * as p from "@clack/prompts";

import { createZip } from "@/utils/createZip";
import { getDefaultTargetAppVersion } from "@/utils/getDefaultTargetAppVersion";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { getGitCommitHash, getLatestGitCommitMessage } from "@/utils/git";
import { type Platform, getCwd, loadConfig } from "@hot-updater/plugin-core";

export interface DeployOptions {
  targetAppVersion?: string;
  platform: Platform;
  forceUpdate: boolean;
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

  const targetAppVersion =
    options.targetAppVersion ??
    (await getDefaultTargetAppVersion(cwd, options.platform));

  if (!targetAppVersion) {
    throw new Error(
      "Target app version not found. Please provide a target app version.",
    );
  }

  let bundleId: string;
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
            platform: options.platform,
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
          await databasePlugin.appendBundle({
            forceUpdate: options.forceUpdate,
            platform: options.platform,
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

    p.note("🚀 Deployment Successful");
    // TODO
    // if port 1422 is open, open consle (http://localhost:1422/bundle_id)
    // if port 1422 is not open, run console (hot-updater console), and open console (http://localhost:1422/bundle_id)
  } catch (e) {
    await databasePlugin.onUnmount?.();
    console.error(e);
    process.exit(1);
  } finally {
    await databasePlugin.onUnmount?.();
  }
};
