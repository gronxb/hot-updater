import fs from "fs";
import path from "path";
import type { PluginObj } from "@babel/core";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { uuidv7 } from "uuidv7";

export default function replaceHotUpdaterBundleId(): PluginObj {
  const buildOutDir = process.env["BUILD_OUT_DIR"];

  if (!buildOutDir) {
    return {
      name: "replace-hot-updater-bundle-id",
      visitor: {
        MemberExpression(path: NodePath<t.MemberExpression>) {
          if (
            t.isIdentifier(path.node.object, { name: "HotUpdater" }) &&
            t.isIdentifier(path.node.property, {
              name: "HOT_UPDATER_BUNDLE_ID",
            })
          ) {
            path.replaceWith(
              t.stringLiteral("00000000-0000-0000-0000-000000000000"),
            );
          }
        },
      },
    };
  }

  const bundleIdPath = path.join(buildOutDir, "BUNDLE_ID");

  let bundleId = uuidv7();

  if (fs.existsSync(bundleIdPath)) {
    bundleId = fs.readFileSync(bundleIdPath, "utf-8");
  } else {
    fs.writeFileSync(bundleIdPath, bundleId);
  }

  return {
    name: "replace-hot-updater-bundle-id",
    visitor: {
      MemberExpression(path: NodePath<t.MemberExpression>) {
        if (
          t.isIdentifier(path.node.object, { name: "HotUpdater" }) &&
          t.isIdentifier(path.node.property, {
            name: "HOT_UPDATER_BUNDLE_ID",
          })
        ) {
          path.replaceWith(t.stringLiteral(bundleId));
        }
      },
    },
  };
}
