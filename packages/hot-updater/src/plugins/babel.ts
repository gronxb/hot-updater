import type { PluginObj } from "@babel/core";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { NIL_UUID } from "@hot-updater/core";

export default function replaceHotUpdaterBundleId(): PluginObj {
  const bundleId = process.env["HOT_UPDATER_BUNDLE_ID"] ?? NIL_UUID;

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
