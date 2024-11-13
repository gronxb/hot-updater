import type { PluginObj } from "@babel/core";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { uuidv7 } from "uuidv7";

export default function replaceHotUpdaterBundleId(): PluginObj {
  return {
    name: "replace-hot-updater-bundle-id",
    visitor: {
      MemberExpression(path: NodePath<t.MemberExpression>) {
        if (
          t.isIdentifier(path.node.object, { name: "env" }) &&
          t.isIdentifier(path.node.property, {
            name: "HOT_UPDATER_BUNDLE_ID",
          })
        ) {
          path.replaceWith(t.stringLiteral(uuidv7()));
        }
      },
    },
  };
}
