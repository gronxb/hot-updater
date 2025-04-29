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
  jsMapPath: string,
  hbcMapPath: string | null,
) => {
  if (!hbcMapPath) {
    return jsMapPath;
  }
  const jsMap = JSON.parse(fs.readFileSync(jsMapPath, "utf8"));
  const debugId = jsMap.debug_id;

  const hbcMap = JSON.parse(fs.readFileSync(hbcMapPath, "utf8"));
  hbcMap.debug_id = debugId;
  fs.writeFileSync(hbcMapPath, JSON.stringify(hbcMap, null, 2));

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

        const sourcemapFile = injectDebugIdToHbcMap(bundleMapFile, hbcMapFile);

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
