import fs from "fs";
import {
  type BasePluginArgs,
  type BuildPlugin,
  getCwd,
} from "@hot-updater/plugin-core";
import type { SentryCliOptions } from "@sentry/cli";
import SentryCli from "@sentry/cli";

export const withSentry =
  (buildFn: (args: BasePluginArgs) => BuildPlugin, config: SentryCliOptions) =>
  (args: BasePluginArgs): BuildPlugin => {
    const context = buildFn(args);
    return {
      ...context,
      build: async (args) => {
        const result = await context.build(args);
        const sentry = new SentryCli(null, {
          org: config.org,
          authToken: config.authToken,
        });

        const include: string[] = [];
        const files = await fs.promises.readdir(result.buildPath, {
          recursive: true,
        });
        for (const file of files) {
          if (file.endsWith(".map") || file.endsWith(".bundle")) {
            include.push(file);
          }
        }

        await sentry.releases.newDeploy(result.bundleId, {
          env: args.channel,
        });
        await sentry.releases.uploadSourceMaps(result.bundleId, {
          include,

          stripPrefix: [getCwd()],
        });
        await sentry.releases.finalize(result.bundleId);
        return result;
      },
    };
  };
