import fs from "fs";
import path from "path";
import type { PluginObj } from "@babel/core";
import type { NodePath } from "@babel/traverse";

import type * as babelTypes from "@babel/types";
import { getCwd } from "@hot-updater/plugin-core";
import picocolors from "picocolors";
import { createSyncFn } from "synckit";
import { uuidv7 } from "uuidv7";

const getMetadataSync = createSyncFn<
  () => {
    fingerprintHash: {
      ios: string;
      android: string;
    };
    releaseChannel: string;
  } | null
>(require.resolve("./worker"), {
  tsRunner: "node",
});

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

export default function ({
  types: t,
}: { types: typeof babelTypes }): PluginObj {
  const bundleId = getBundleId();

  const metadata: {
    fingerprintHash: {
      ios: string;
      android: string;
    } | null;
    releaseChannel: string | null;
    bundleId: string;
  } = {
    fingerprintHash: null,
    releaseChannel: null,
    bundleId: NIL_UUID,
  };
  return {
    name: "hot-updater-babel-plugin",
    pre: () => {
      const hotUpdaterDir = path.join(getCwd(), ".hot-updater");
      const metadataJsonPath = path.join(hotUpdaterDir, "metadata.json");
      // 계소 캐시 됨..
      if (fs.existsSync(metadataJsonPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(metadataJsonPath, "utf-8"));
          Object.assign(metadata, data);
          return;
        } catch (error) {
          console.error("Failed to read metadata.json:", error);
        }
      }

      try {
        const data = getMetadataSync();
        if (!data) {
          throw new Error("Failed to get metadata");
        }

        console.log(
          picocolors.green(
            `[HotUpdater] Fingerprint(iOS): ${data.fingerprintHash.ios}`,
          ),
        );
        console.log(
          picocolors.green(
            `[HotUpdater] Fingerprint(Android): ${data.fingerprintHash.android}`,
          ),
        );
        console.log(
          picocolors.green(
            `[HotUpdater] Release Channel: ${data.releaseChannel}`,
          ),
        );
        console.log(picocolors.green(`[HotUpdater] Bundle ID: ${bundleId}`));

        if (fs.existsSync(hotUpdaterDir)) {
          try {
            fs.rmSync(hotUpdaterDir, { recursive: true, force: true });
          } catch (error) {
            console.error("Failed to remove .hot-updater directory:", error);
          }
        }

        try {
          fs.mkdirSync(hotUpdaterDir, { recursive: true });
          fs.writeFileSync(metadataJsonPath, JSON.stringify(data, null, 2));
          Object.assign(metadata, data);
        } catch (error) {
          console.error(
            "Failed to create .hot-updater directory or write metadata.json:",
            error,
          );
        }
      } catch (error) {
        console.error("Error in hot-updater pre function:", error);
      }
    },
    visitor: {
      Identifier(path: NodePath<babelTypes.Identifier>) {
        if (path.node.name === "__HOT_UPDATER_BUNDLE_ID") {
          path.replaceWith(t.stringLiteral(bundleId));
        }
        if (path.node.name === "__HOT_UPDATER_CHANNEL") {
          path.replaceWith(
            metadata.releaseChannel
              ? t.stringLiteral(metadata.releaseChannel)
              : t.nullLiteral(),
          );
        }
        if (
          metadata.fingerprintHash?.ios &&
          path.node.name === "__HOT_UPDATER_FINGERPRINT_HASH_IOS"
        ) {
          path.replaceWith(t.stringLiteral(metadata.fingerprintHash.ios));
        }
        if (
          metadata.fingerprintHash?.android &&
          path.node.name === "__HOT_UPDATER_FINGERPRINT_HASH_ANDROID"
        ) {
          path.replaceWith(t.stringLiteral(metadata.fingerprintHash.android));
        }
      },
    },
  };
}
