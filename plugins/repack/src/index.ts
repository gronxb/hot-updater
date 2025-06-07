import fs from "fs";
import path from "path";
import { getCwd, loadConfigSync } from "@hot-updater/plugin-core";
import type { Compiler, RspackPluginInstance } from "@rspack/core";
import { memoize } from "es-toolkit/function";
import picocolors from "picocolors";
import { uuidv7 } from "uuidv7";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const memoizeLoadConfig = memoize(loadConfigSync);

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

const getFingerprintJson = () => {
  const { updateStrategy } = memoizeLoadConfig(null);
  if (updateStrategy === "appVersion") {
    return null;
  }
  const fingerprintPath = path.join(getCwd(), "fingerprint.json");
  if (!fs.existsSync(fingerprintPath)) {
    throw new Error(
      "Missing fingerprint.json. Since updateStrategy is set to 'fingerprint' in hot-updater.config, please run `hot-updater fingerprint create`.",
    );
  }
  try {
    const fingerprint = JSON.parse(
      fs.readFileSync(fingerprintPath, "utf-8"),
    ) as {
      ios: {
        hash: string;
      };
      android: {
        hash: string;
      };
    };

    return {
      iosHash: fingerprint.ios.hash,
      androidHash: fingerprint.android.hash,
    };
  } catch {
    throw new Error(
      "Invalid fingerprint.json. Since updateStrategy is set to 'fingerprint' in hot-updater.config, please run `hot-updater fingerprint create`.",
    );
  }
};

export class HotUpdaterPlugin implements RspackPluginInstance {
  apply(compiler: Compiler) {
    const fingerprint = getFingerprintJson();
    const { updateStrategy } = memoizeLoadConfig(null);

    new compiler.webpack.DefinePlugin({
      __HOT_UPDATER_BUNDLE_ID: JSON.stringify(getBundleId()),
      __HOT_UPDATER_FINGERPRINT_HASH_IOS: JSON.stringify(
        fingerprint?.iosHash ?? null,
      ),
      __HOT_UPDATER_FINGERPRINT_HASH_ANDROID: JSON.stringify(
        fingerprint?.androidHash ?? null,
      ),
      __HOT_UPDATER_UPDATE_STRATEGY: JSON.stringify(updateStrategy),
    }).apply(compiler);
  }
}
