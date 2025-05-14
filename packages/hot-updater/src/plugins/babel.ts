import { memoize } from "es-toolkit/function";

import fs from "fs";
import path from "path";
import type { PluginObj } from "@babel/core";
import type { NodePath } from "@babel/traverse";

import type * as babelTypes from "@babel/types";
import { getCwd, loadConfigSync } from "@hot-updater/plugin-core";
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

const memoizeLoadConfig = memoize(loadConfigSync);

export const getChannel = () => {
  const currentEnv = process.env["BABEL_ENV"] || process.env["NODE_ENV"];
  if (currentEnv === "development") {
    return null;
  }

  const envChannel = process.env["HOT_UPDATER_CHANNEL"];
  if (envChannel) {
    return envChannel;
  }

  const { releaseChannel } = memoizeLoadConfig(null);
  return releaseChannel;
};

export const getFingerprintJson = () => {
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

export default function ({
  types: t,
}: { types: typeof babelTypes }): PluginObj {
  const bundleId = getBundleId();
  const channel = getChannel();
  const fingerprint = getFingerprintJson();

  const { updateStrategy } = memoizeLoadConfig(null);
  return {
    name: "hot-updater-babel-plugin",
    visitor: {
      Identifier(path: NodePath<babelTypes.Identifier>) {
        if (path.node.name === "__HOT_UPDATER_BUNDLE_ID") {
          path.replaceWith(t.stringLiteral(bundleId));
        }
        if (path.node.name === "__HOT_UPDATER_CHANNEL") {
          path.replaceWith(
            channel ? t.stringLiteral(channel) : t.nullLiteral(),
          );
        }
        if (path.node.name === "__HOT_UPDATER_FINGERPRINT_HASH_IOS") {
          fingerprint?.iosHash
            ? path.replaceWith(t.stringLiteral(fingerprint.iosHash))
            : path.replaceWith(t.nullLiteral());
        }
        if (path.node.name === "__HOT_UPDATER_FINGERPRINT_HASH_ANDROID") {
          fingerprint?.androidHash
            ? path.replaceWith(t.stringLiteral(fingerprint.androidHash))
            : path.replaceWith(t.nullLiteral());
        }
        if (path.node.name === "__HOT_UPDATER_UPDATE_STRATEGY") {
          path.replaceWith(t.stringLiteral(updateStrategy));
        }
      },
    },
  };
}
