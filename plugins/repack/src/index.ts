import fs from "fs";
import path from "path";
import { loadConfigSync } from "@hot-updater/plugin-core";
import type { Compiler, RspackPluginInstance } from "@rspack/core";
import picocolors from "picocolors";
import { uuidv7 } from "uuidv7";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const getBundleId = () => {
  const buildOutDir = process.env["BUILD_OUT_DIR"];
  if (!buildOutDir) {
    return NIL_UUID;
  }

  const bundleIdPath = path.join(buildOutDir, "BUNDLE_ID");

  let bundleId = uuidv7();

  if (fs.existsSync(bundleIdPath)) {
    bundleId = fs.readFileSync(bundleIdPath, "utf-8");
  } else {
    fs.writeFileSync(bundleIdPath, bundleId);
    console.log(
      picocolors.green(`[HotUpdater] Generated bundle ID: ${bundleId}`),
    );
  }

  return bundleId;
};

export const getChannel = () => {
  const currentEnv = process.env["BABEL_ENV"] || process.env["NODE_ENV"];
  if (currentEnv === "development") {
    return null;
  }

  const envChannel = process.env["HOT_UPDATER_CHANNEL"];
  if (envChannel) {
    return envChannel;
  }

  const { releaseChannel } = loadConfigSync(null);
  return releaseChannel;
};

export class HotUpdaterPlugin implements RspackPluginInstance {
  apply(compiler: Compiler) {
    new compiler.webpack.DefinePlugin({
      "HotUpdater.HOT_UPDATER_BUNDLE_ID": JSON.stringify(getBundleId()),
      "HotUpdater.CHANNEL": JSON.stringify(getChannel()),
    }).apply(compiler);
  }
}
