import fs from "fs";
import * as p from "@clack/prompts";
import { type Platform, getCwd, loadConfig } from "@hot-updater/plugin-core";

import { getPlatform } from "@/prompts/getPlatform";

import path from "path";
import {
  createAndInjectFingerprintFiles,
  isFingerprintEquals,
  readLocalFingerprint,
} from "@/utils/fingerprint";
import { runNativeBuild } from "@/utils/native/runNativeBuild";
import { getDefaultOutputPath } from "@/utils/output/getDefaultOutputPath";
import { printBanner } from "@/utils/printBanner";
import { getNativeAppVersion } from "@/utils/version/getNativeAppVersion";
import { ExecaError } from "execa";
import picocolors from "picocolors";

export interface NativeRunOptions {
  outputPath?: string;
  interactive: boolean;
  message?: string;
  platform?: Platform;
  scheme?: string;
}

export const nativeRun = async (options: NativeRunOptions) => {
  printBanner();

  if (!options.scheme && !options.interactive) {
    p.log.error("required option '-s, --scheme <scheme>' not specified");
    return;
  }

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
    p.log.error("No config found. Please run `hot-updater init` first.");
    process.exit(1);
  }

  const availableSchemes = Object.keys(config.nativeBuild[platform]).sort();

  if (!availableSchemes.length) {
    // TODO: add documentation links
    p.log.error(`configure your native build schemes for ${platform} first.`);
    return;
  }

  const scheme =
    options.scheme ??
    (await p.select({
      message: "Which scheme do you use to build?",
      options: availableSchemes.map((s) => ({ label: s, value: s })),
    }));

  if (p.isCancel(scheme)) {
    return;
  }

  if (!(scheme in config.nativeBuild[platform])) {
    p.log.error(
      `scheme ${picocolors.blueBright(options.scheme)} is not in predefined schemes [${picocolors.blueBright(availableSchemes.join(", "))}]`,
    );
    return;
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
        ? config.nativeBuild.android[scheme]!.aab
          ? "aab"
          : "apk"
        : "",
    );

  const normalizeOutputPath = path.isAbsolute(artifactResultStorePath)
    ? artifactResultStorePath
    : path.join(cwd, artifactResultStorePath);

  const artifactPath = path.join(normalizeOutputPath, platform);

  // TODO: store and upload in your mind
  const [buildPlugin /* storagePlugin, databasePlugin */] = await Promise.all([
    config.build({
      cwd,
    }),
    // config.storage({
    //   cwd,
    // }),
    // config.database({
    //   cwd,
    // }),
  ]);

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
            scheme,
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
    if (taskRef.buildResult.stdout) {
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
    // await databasePlugin.onUnmount?.();
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
    // await databasePlugin.onUnmount?.();
    await fs.promises.rm(artifactPath, { force: true });
  }
};
