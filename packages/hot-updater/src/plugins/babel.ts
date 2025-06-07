import fs from "fs";
import path from "path";
import type { PluginObj } from "@babel/core";
import type { NodePath } from "@babel/traverse";

import type * as babelTypes from "@babel/types";
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

export default function ({
  types: t,
}: { types: typeof babelTypes }): PluginObj {
  const bundleId = getBundleId();
  return {
    name: "hot-updater-babel-plugin",
    visitor: {
      Identifier(path: NodePath<babelTypes.Identifier>) {
        if (path.node.name === "__HOT_UPDATER_BUNDLE_ID") {
          path.replaceWith(t.stringLiteral(bundleId));
        }
      },
    },
  };
}
