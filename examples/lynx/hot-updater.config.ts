import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { lynx } from "../../packages/lynx/dist/build.mjs";
import { standaloneRepository } from "../../plugins/standalone/dist/index.mjs";

const run = promisify(execFile);

const runtimeId = (platform: "ios" | "android") =>
  platform === "ios"
    ? "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v2"
    : "android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v2";

export default {
  updateStrategy: "appVersion",
  compressStrategy: "zip",
  /* E2E_AUTO_PATCH_CONFIG_START */
  patch: {
    enabled: false,
    maxBaseBundles: 2,
  },
  /* E2E_AUTO_PATCH_CONFIG_END */
  build: lynx({
    build: async ({ cwd, outDir, platform }) => {
      await run(
        "pnpm",
        [
          "exec",
          "rspeedy",
          "build",
          "--config",
          "e2e.lynx.config.ts",
          "--environment",
          "lynx",
        ],
        {
          cwd,
          env: {
            ...process.env,
            HOT_UPDATER_BUILD_DIR: outDir,
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return {
        entry: "main.lynx.bundle",
        runtimeId: runtimeId(platform),
      };
    },
  }),
  database: standaloneRepository({
    baseUrl:
      process.env.HOT_UPDATER_STANDALONE_BASE_URL ??
      `${process.env.HOT_UPDATER_APP_BASE_URL ?? "http://127.0.0.1:3007/hot-updater"}/admin`,
  }),
};
