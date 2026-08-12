import fs from "fs";
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

interface WithBugsnagConfig {
  /**
   * The BugSnag API key of the project the source maps belong to.
   */
  apiKey: string;
  /**
   * A unique identifier for the JavaScript bundle so BugSnag can match errors
   * to the deployed OTA bundle. Defaults to the hot-updater bundle id
   * generated for the deploy. The same value must be passed as
   * `codeBundleId` when starting BugSnag in your app.
   */
  codeBundleId?: string;
  /**
   * Whether to overwrite an existing upload with the same identifier
   * instead of failing.
   */
  overwrite?: boolean;
  /**
   * The path to strip from the beginning of source file names referenced in
   * stacktraces on the BugSnag dashboard. Defaults to the current working
   * directory.
   */
  projectRoot?: string;
}

export const withBugsnag =
  (buildFn: (args: BasePluginArgs) => BuildPlugin, config: WithBugsnagConfig) =>
  (args: BasePluginArgs): BuildPlugin => {
    const context = buildFn(args);
    return {
      ...context,
      build: async (buildArgs) => {
        const result = await context.build(buildArgs);

        const files = await fs.promises.readdir(result.buildPath, {
          recursive: true,
        });

        const javascriptBundleFilename = `index.${buildArgs.platform}.bundle`;
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

        const selectedBundleFilePath = hermesBundlePath ?? javascriptBundlePath;
        const selectedSourcemapFilePath =
          hermesBundleSourcemapPath ?? javascriptBundleSourcemapPath;

        await execa("npx", [
          "bugsnag-cli",
          "upload",
          "react-native-sourcemaps",
          "--api-key",
          config.apiKey,
          "--platform",
          buildArgs.platform,
          "--bundle",
          selectedBundleFilePath,
          "--source-map",
          selectedSourcemapFilePath,
          "--code-bundle-id",
          config.codeBundleId ?? result.bundleId,
          "--project-root",
          config.projectRoot ?? args.cwd,
          ...(config.overwrite ? ["--overwrite"] : []),
        ]);

        return result;
      },
    };
  };
