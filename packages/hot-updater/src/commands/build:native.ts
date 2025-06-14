import fs from "fs";
import { getLatestGitCommit } from "@/utils/git";
import * as p from "@clack/prompts";
import { type Platform, getCwd, loadConfig } from "@hot-updater/plugin-core";

import { getPlatform } from "@/prompts/getPlatform";

import path from "path";
import { nativeFingerprint } from "@/utils/fingerprint";
import { runNativeBuild } from "@/utils/nativeBuild/runNativeBuild";
import { printBanner } from "@/utils/printBanner";
import { getNativeAppVersion } from "@/utils/version/getNativeAppVersion";
import { ExecaError } from "execa";

export interface NativeBuildOptions {
  outputPath?: string;
  interactive: boolean;
  message?: string;
  platform?: Platform;
}

export const nativeBuild = async (options: NativeBuildOptions) => {
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
  {
    const s = p.spinner();
    s.start(`Fingerprinting (${platform})`);
    const fingerprint = await nativeFingerprint(cwd, {
      platform,
      ...config.fingerprint,
    });

    target.fingerprintHash = fingerprint.hash;
    s.stop(`Fingerprint(${platform}): ${fingerprint.hash}`);

    if (!target.fingerprintHash) {
      p.log.error(`Failed to calculate fingerprint of ${platform}`);
      return;
    }
  }

  // get native app version
  {
    const s = p.spinner();
    s.start(`Get native pap version (${platform})`);

    const appVersion = await getNativeAppVersion(platform);

    s.stop(`App Version(${platform}): ${appVersion}`);

    target.appVersion = appVersion;

    if (!target.appVersion) {
      p.log.error(`Failed to retrieve native app version of ${platform}`);
      return;
    }
  }

  const nativeBuildConfig = config.nativeBuild;

  const outputPath = options.outputPath ?? path.join(cwd, "nativebuild"); // TODO any suggestion?

  const normalizeOutputPath = path.isAbsolute(outputPath)
    ? outputPath
    : path.join(cwd, outputPath);

  const artifactPath = path.join(normalizeOutputPath, platform);

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
        stdout: string | null;
      } | null;
      storageUri: string | null;
    } = {
      buildResult: null,
      storageUri: null,
    };

    await p.tasks([
      {
        title: `📦 Building Native (${buildPlugin.name})`,
        task: async () => {
          await new Promise((r) => setTimeout(r, 3000));
          taskRef.buildResult = await buildPlugin.nativeBuild({
            platform: platform,
            // inject native build function into plugins
            // then plugin will run it with pre/post required steps for each framework
            buildNativeArtifact: async () => {
              await runNativeBuild({
                platform,
                config: config.nativeBuild,
              });
            },
          });

          await fs.promises.mkdir(normalizeOutputPath, { recursive: true });

          // const files = await fs.promises.readdir(buildPath, {
          //   recursive: true,
          // });

          /*    const targetFiles = await getBundleZipTargets(
            buildPath,
            files
              .filter(
                (file) =>
                  !fs.statSync(path.join(buildPath, file)).isDirectory(),
              )
              .map((file) => path.join(buildPath, file)),
          );
          await createZipTargetFiles({
            outfile: artifactPath,
            targetFiles: targetFiles,
          });

          bundleId = taskRef.buildResult.bundleId;
          fileHash = await getFileHashFromFile(artifactPath);*/

          return `Build Complete (${buildPlugin.name})`;
        },
      },
    ]);
    if (taskRef.buildResult?.stdout) {
      p.log.success(taskRef.buildResult.stdout);
    }
    /*
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
                  artifactPath,
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
                  enabled: true,
                  channel,
                  targetAppVersion: target.appVersion,
                  fingerprintHash: target.fingerprintHash,
                  storageUri: taskRef.storageUri,
                  metadata: {
                    ...(appVersion
                      ? {
                          app_version: appVersion,
                        }
                      : {}),
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
              await fs.promises.rm(artifactPath);

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
     */
  } catch (e) {
    await databasePlugin.onUnmount?.();
    await fs.promises.rm(artifactPath, { force: true });
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
    await fs.promises.rm(artifactPath, { force: true });
  }
};
