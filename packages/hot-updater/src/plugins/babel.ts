import type { PluginObj } from "@babel/core";
import type { NodePath } from "@babel/traverse";
import type * as babelTypes from "@babel/types";
import { colors } from "@hot-updater/cli-tools";
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
    console.log(colors.green(`[HotUpdater] Generated bundle ID: ${bundleId}`));
  }

  return bundleId;
};

/**
 * Hot Updater Babel Plugin
 *
 * This plugin handles two transformations:
 * 1. Replaces __HOT_UPDATER_BUNDLE_ID with the actual bundle ID
 * 2. Transforms Expo DOM component filePath to overrideUri for OTA updates
 */
export default function ({
  types: t,
}: {
  types: typeof babelTypes;
}): PluginObj {
  const bundleId = getBundleId();

  return {
    name: "hot-updater-babel-plugin",
    visitor: {
      Identifier(path: NodePath<babelTypes.Identifier>) {
        // Transform __HOT_UPDATER_BUNDLE_ID to actual bundle ID
        if (path.node.name === "__HOT_UPDATER_BUNDLE_ID") {
          path.replaceWith(t.stringLiteral(bundleId));
        }
      },
      Program: {
        exit(programPath) {
          // Collect filePath declarations
          const filePathDeclarations = new Map<string, string>();

          programPath.node.body.forEach((node) => {
            if (
              t.isVariableDeclaration(node) &&
              node.declarations.length > 0
            ) {
              node.declarations.forEach((declarator) => {
                if (
                  t.isVariableDeclarator(declarator) &&
                  t.isIdentifier(declarator.id) &&
                  declarator.id.name === "filePath" &&
                  t.isStringLiteral(declarator.init) &&
                  declarator.init.value.endsWith(".html")
                ) {
                  filePathDeclarations.set(
                    declarator.id.name,
                    declarator.init.value,
                  );
                }
              });
            }
          });

          // Transform filePath properties
          programPath.traverse({
            ObjectExpression(objPath) {
              const filePathProp = objPath.node.properties.find(
                (prop) =>
                  t.isObjectProperty(prop) &&
                  t.isIdentifier(prop.key, { name: "filePath" }) &&
                  (t.isIdentifier(prop.value, { name: "filePath" }) ||
                    (t.isStringLiteral(prop.value) &&
                      prop.value.value.endsWith(".html"))),
              );

              if (!filePathProp || !t.isObjectProperty(filePathProp)) return;

              // Verify parent is createElement(WebView, ...)
              const parent = objPath.parent;
              if (
                !t.isCallExpression(parent) ||
                !t.isMemberExpression(parent.callee) ||
                !t.isIdentifier(parent.callee.property, {
                  name: "createElement",
                })
              ) {
                return;
              }

              const firstArg = parent.arguments[0];
              const isWebView =
                (t.isIdentifier(firstArg) &&
                  (firstArg.name === "WebView" ||
                    firstArg.name.endsWith("WebView"))) ||
                (t.isMemberExpression(firstArg) &&
                  t.isIdentifier(firstArg.property, { name: "WebView" }));

              if (!isWebView) return;

              // Get fileName
              const filePathValue = filePathProp.value;
              let fileName: string;

              if (t.isStringLiteral(filePathValue)) {
                fileName = filePathValue.value;
              } else if (t.isIdentifier(filePathValue)) {
                const declaredValue = filePathDeclarations.get(
                  filePathValue.name,
                );
                if (!declaredValue) return;
                fileName = declaredValue;
              } else {
                return;
              }

              // Create safeGetBaseURL expression
              const safeGetBaseURL = t.conditionalExpression(
                t.logicalExpression(
                  "&&",
                  t.binaryExpression(
                    "!==",
                    t.unaryExpression("typeof", t.identifier("globalThis"), true),
                    t.stringLiteral("undefined"),
                  ),
                  t.memberExpression(
                    t.identifier("globalThis"),
                    t.identifier("HotUpdaterGetBaseURL"),
                  ),
                ),
                t.callExpression(
                  t.memberExpression(
                    t.identifier("globalThis"),
                    t.identifier("HotUpdaterGetBaseURL"),
                  ),
                  [],
                ),
                t.unaryExpression("void", t.numericLiteral(0), true),
              );

              // Create overrideUri property
              const overrideUriProp = t.objectProperty(
                t.identifier("overrideUri"),
                t.callExpression(
                  t.memberExpression(
                    t.arrayExpression([
                      safeGetBaseURL,
                      t.stringLiteral("www.bundle"),
                      t.stringLiteral(fileName),
                    ]),
                    t.identifier("join"),
                  ),
                  [t.stringLiteral("/")],
                ),
              );

              // Find spread element
              const spreadElement = objPath.node.properties.find((prop) =>
                t.isSpreadElement(prop),
              ) as babelTypes.SpreadElement | undefined;

              // Create dom property
              const domProps =
                spreadElement && t.isIdentifier(spreadElement.argument)
                  ? [
                      t.spreadElement(
                        t.memberExpression(
                          spreadElement.argument,
                          t.identifier("dom"),
                        ),
                      ),
                      overrideUriProp,
                    ]
                  : [overrideUriProp];

              const domProperty = t.objectProperty(
                t.identifier("dom"),
                t.objectExpression(domProps),
              );

              // Replace filePath with dom
              const propIndex = objPath.node.properties.indexOf(filePathProp);
              objPath.node.properties.splice(propIndex, 1, domProperty);
            },
          });
        },
      },
    },
  };
}
