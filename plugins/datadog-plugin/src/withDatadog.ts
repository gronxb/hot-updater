import fs from "fs";
import os from "os";
import path from "path";
import type { BasePluginArgs, BuildPlugin } from "@hot-updater/plugin-core";
import { execa } from "execa";

const ensureFilePath = (
  files: string[],
  basePath: string,
  filename: string,
) => {
  const file = files.find((file) => file.includes(filename));

  if (!file) {
    return null;
  }

  return path.resolve(basePath, file);
};

interface WithDatadogConfig {
  buildNumber: string;
  releaseVersion: string;
  repositoryUrl?: string;
  service: string;
}

export const withDatadog =
  (buildFn: (args: BasePluginArgs) => BuildPlugin, config: WithDatadogConfig) =>
  (args: BasePluginArgs): BuildPlugin => {
    const context = buildFn(args);
    return {
      ...context,
      build: async (args) => {
        const tmpDir = await fs.promises.mkdtemp(
          path.join(os.tmpdir(), "hot-updater-datadog-sourcemap-"),
        );

        try {
          const result = await context.build(args);

          const files = await fs.promises.readdir(result.buildPath, {
            recursive: true,
          });

          const javascriptBundleFilename = `index.${args.platform}.bundle`;
          const javascriptBundleSourcemapFilename = `${javascriptBundleFilename}.map`;
          const hermesBundleFilename = `${javascriptBundleFilename}.hbc`;
          const hermesBundleSourcemapFilename = `${javascriptBundleFilename}.hbc.map`;

          const javascriptBundlePath = ensureFilePath(
            files,
            result.buildPath,
            javascriptBundleFilename,
          );

          const javascriptBundleSourcemapPath = ensureFilePath(
            files,
            result.buildPath,
            javascriptBundleSourcemapFilename,
          );

          const hermesBundlePath = ensureFilePath(
            files,
            result.buildPath,
            hermesBundleFilename,
          );

          const hermesBundleSourcemapPath = ensureFilePath(
            files,
            result.buildPath,
            hermesBundleSourcemapFilename,
          );

          if (!javascriptBundlePath || !javascriptBundleSourcemapPath) {
            throw new Error(
              "Sourcemap or original bundle not found. Please enable sourcemap in your build plugin. e.g build: bare({ sourcemap: true })",
            );
          }

          if (!!hermesBundlePath !== !!hermesBundleSourcemapPath) {
            throw new Error(
              "Hermes bundle or sourcemap not found. Please enable Hermes in your build plugin. e.g build: bare({ hermes: true })",
            );
          }

          const selectedBundleFilePath =
            hermesBundlePath ?? javascriptBundlePath;
          const selectedSourcemapFilePath =
            hermesBundleSourcemapPath ?? javascriptBundleSourcemapPath;

          const tmpDirBundleFilePath = path.join(
            tmpDir,
            javascriptBundleFilename,
          );
          const tmpDirBundleSourcemapFilePath = path.join(
            tmpDir,
            javascriptBundleSourcemapFilename,
          );

          await fs.promises.copyFile(
            selectedBundleFilePath,
            tmpDirBundleFilePath,
          );
          await fs.promises.copyFile(
            selectedSourcemapFilePath,
            tmpDirBundleSourcemapFilePath,
          );

          await execa("npx", [
            "datadog-ci",
            "react-native",
            "upload",
            "--platform",
            args.platform,
            "--service",
            config.service,
            "--bundle",
            tmpDirBundleFilePath,
            "--sourcemap",
            tmpDirBundleSourcemapFilePath,
            "--release-version",
            config.releaseVersion,
            "--build-version",
            config.buildNumber,
            ...(config.repositoryUrl
              ? ["--repository-url", config.repositoryUrl]
              : []),
          ]);

          return result;
        } finally {
          await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
      },
    };
  };
