import { colors as picocolors } from "@hot-updater/cli-tools";
import type { Compiler, RspackPluginInstance } from "@rspack/core";
import fs from "fs";
import path from "path";
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

export class HotUpdaterPlugin implements RspackPluginInstance {
  apply(compiler: Compiler) {
    new compiler.webpack.DefinePlugin({
      __HOT_UPDATER_BUNDLE_ID: JSON.stringify(getBundleId()),
    }).apply(compiler);
  }
}
