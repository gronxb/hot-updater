import fs from "node:fs/promises";
import path from "node:path";

import { lynx } from "../../packages/lynx/dist/build.mjs";
import { standaloneRepository } from "../../plugins/standalone/dist/index.mjs";

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
      const source = path.join(cwd, "dist/react");
      await fs.cp(source, outDir, { recursive: true });
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
