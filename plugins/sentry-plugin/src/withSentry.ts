import fs from "fs";
import path from "path";
import {
  type BasePluginArgs,
  type BuildPlugin,
  getCwd,
} from "@hot-updater/plugin-core";
import type { SentryCliOptions } from "@sentry/cli";
import SentryCli from "@sentry/cli";

const injectDebugIdToHbcMap = (
  jsCodePath: string,
  jsMapPath: string,
  hbcMapPath: string | null,
) => {
  if (!hbcMapPath) {
    return jsMapPath;
  }
  const jsMap = JSON.parse(fs.readFileSync(jsMapPath, "utf8"));
  let debugId: string | undefined = jsMap.debug_id || jsMap.debugId;

  if (!debugId) {
    // Fallback to debugId from jsCode
    const jsCode = fs.readFileSync(jsCodePath, "utf8");
    const debugIdMatch = jsCode.match(/\/\/# debugId=([a-f0-9-]+)/);
    debugId = debugIdMatch ? debugIdMatch[1] : undefined;

    if (!debugId) {
      throw new Error(
        "debugId from Source map not found. It seems hot-updater doesn't support Sentry plugin with this bundle framework. Please pile issue on Github.",
      );
    }
  }

  const hbcMap = JSON.parse(fs.readFileSync(hbcMapPath, "utf8"));
  hbcMap.debug_id = debugId;
  hbcMap.debugId = debugId;
  fs.writeFileSync(hbcMapPath, JSON.stringify(hbcMap, null, 0));

  fs.unlinkSync(jsMapPath);
  fs.renameSync(hbcMapPath, jsMapPath);
  return jsMapPath;
};

const ensureFilePath = (files: string[], bsaePath: string, suffix: string) => {
  const file = files.find((file) => file.endsWith(suffix));
  if (!file) {
    return null;
  }
  return path.join(bsaePath, file);
};

export const withSentry =
  (buildFn: (args: BasePluginArgs) => BuildPlugin, config: SentryCliOptions) =>
  (args: BasePluginArgs): BuildPlugin => {
    const context = buildFn(args);
    return {
      ...context,
      build: async (args) => {
        const result = await context.build(args);
        const sentry = new SentryCli(null, config);

        const files = await fs.promises.readdir(result.buildPath, {
          recursive: true,
        });

        const bundleMapFile = ensureFilePath(
          files,
          result.buildPath,
          ".bundle.map",
        );
        const hbcMapFile = ensureFilePath(files, result.buildPath, ".hbc.map");
        const bundleFile = ensureFilePath(files, result.buildPath, ".bundle");

        if (!bundleMapFile || !bundleFile) {
          throw new Error(
            "Source map not found. Please enable sourcemap in your build plugin. e.g build: bare({ sourcemap: true })",
          );
        }

        const sourcemapFile = injectDebugIdToHbcMap(
          bundleFile,
          bundleMapFile,
          hbcMapFile,
        );

        await sentry.execute(
          [
            "sourcemaps",
            "upload",
            "--debug-id-reference",
            "--strip-prefix",
            getCwd(),
            sourcemapFile,
            bundleFile,
          ],
          true,
        );

        return result;
      },
    };
  };
