import fs from "node:fs/promises";
import path from "node:path";
import type { PluginObj } from "@babel/core";
import { transform } from "@babel/core";
import type * as babelTypes from "@babel/types";
import { colors } from "@hot-updater/cli-tools";

export interface TransformResult {
  transformed: boolean;
  occurrences: number;
}

/**
 * Babel plugin to transform Metro bundler minified code (ES5-compatible)
 * Transforms: filePath:"file.html"
 * To: dom:{...f.dom,overrideUri:[(typeof globalThis!=="undefined"&&globalThis.HotUpdaterGetBaseURL)?globalThis.HotUpdaterGetBaseURL():void 0,"www.bundle","file.html"].join("/")}
 */
function createMetroBundleTransformPlugin(): {
  plugin: (api: { types: typeof babelTypes }) => PluginObj;
  getCount: () => number;
} {
  let transformCount = 0;

  const plugin = (api: { types: typeof babelTypes }): PluginObj => {
    const { types: t } = api;

    return {
      name: "metro-bundle-transform",
      visitor: {
        ObjectExpression(path) {
          // Find filePath property in object expressions
          const filePathProp = path.node.properties.find(
            (prop) =>
              t.isObjectProperty(prop) &&
              t.isIdentifier(prop.key, { name: "filePath" }) &&
              t.isStringLiteral(prop.value) &&
              prop.value.value.endsWith(".html"),
          );

          if (!filePathProp || !t.isObjectProperty(filePathProp)) {
            return;
          }

          const filePathValue = filePathProp.value;
          if (!t.isStringLiteral(filePathValue)) {
            return;
          }

          const fileName = filePathValue.value;

          // Find if there's a spread element (e.g., ...f)
          const spreadElement = path.node.properties.find((prop) =>
            t.isSpreadElement(prop),
          ) as babelTypes.SpreadElement | undefined;

          let domObjectExpression: babelTypes.ObjectExpression;

          // Create ES5-compatible globalThis check and HotUpdaterGetBaseURL call
          // (typeof globalThis !== "undefined" && globalThis.HotUpdaterGetBaseURL) ? globalThis.HotUpdaterGetBaseURL() : void 0
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

          if (spreadElement && t.isIdentifier(spreadElement.argument)) {
            // Create: dom: { ...f.dom, overrideUri: [...].join("/") }
            domObjectExpression = t.objectExpression([
              t.spreadElement(
                t.memberExpression(spreadElement.argument, t.identifier("dom")),
              ),
              t.objectProperty(
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
              ),
            ]);
          } else {
            // Create: dom: { overrideUri: [...].join("/") }
            domObjectExpression = t.objectExpression([
              t.objectProperty(
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
              ),
            ]);
          }

          const domProperty = t.objectProperty(
            t.identifier("dom"),
            domObjectExpression,
          );

          // Replace filePath with dom property
          const propIndex = path.node.properties.indexOf(filePathProp);
          path.node.properties.splice(propIndex, 1, domProperty);

          transformCount++;
        },
      },
    };
  };

  return {
    plugin,
    getCount: () => transformCount,
  };
}

/**
 * Checks if a file should be transformed
 * Only .bundle files are transformed, not .hbc (Hermes bytecode) files
 *
 * @param filePath - Path to check
 * @returns true if file should be transformed
 */
export function shouldTransformFile(filePath: string): boolean {
  return filePath.endsWith(".bundle");
}

/**
 * Transforms a Metro bundle file to replace filePath properties with overrideUri
 * for Expo DOM components (generated by "use dom" directive)
 *
 * Uses Babel AST transformation for accurate code manipulation
 *
 * @param bundlePath - Absolute path to the .bundle file
 * @returns Transform result with success status and occurrence count
 */
export async function transformBundle(
  bundlePath: string,
): Promise<TransformResult> {
  try {
    // Validate bundle exists
    const stats = await fs.stat(bundlePath);
    if (!stats.isFile()) {
      console.warn(
        `${colors.yellow("[HotUpdater]")} Not a file: ${bundlePath}`,
      );
      return { transformed: false, occurrences: 0 };
    }

    // Read bundle content
    const content = await fs.readFile(bundlePath, "utf-8");
    const linesBefore = content.split("\n").length;

    // Create plugin instance with count tracking
    const { plugin, getCount } = createMetroBundleTransformPlugin();

    let result: ReturnType<typeof transform> | null = null;
    try {
      // Transform using Babel
      result = transform(content, {
        plugins: [plugin],
        parserOpts: {
          sourceType: "script", // Metro bundles are scripts, not modules
          plugins: ["jsx"], // Enable JSX and modern syntax parsing
        },
        compact: true, // Keep output compact
        comments: false, // Remove comments
        retainLines: true, // Preserve original line structure
        sourceMaps: false,
        filename: bundlePath,
      });
    } catch (transformError) {
      console.warn(
        `${colors.yellow("[HotUpdater]")} Babel transform error: ${transformError}`,
      );
      console.warn("Stack:", (transformError as Error).stack);
      return { transformed: false, occurrences: 0 };
    }

    if (!result || !result.code) {
      console.warn(
        `${colors.yellow("[HotUpdater]")} Failed to transform bundle: no output code`,
      );
      return { transformed: false, occurrences: 0 };
    }

    const occurrences = getCount();

    // Only write if changes were made
    if (occurrences > 0) {
      const linesAfter = result.code.split("\n").length;
      const lineDiff = linesAfter - linesBefore;
      const diffStr = lineDiff >= 0 ? `+${lineDiff}` : `${lineDiff}`;

      await fs.writeFile(bundlePath, result.code, "utf-8");
      console.log(
        `${colors.green("[HotUpdater]")} Transformed ${occurrences} DOM component(s) in ${path.basename(bundlePath)} (lines: ${linesBefore} → ${linesAfter}, ${diffStr})`,
      );
      return { transformed: true, occurrences };
    }

    return { transformed: false, occurrences: 0 };
  } catch (error) {
    // Don't fail the build, just warn
    console.warn(
      `${colors.yellow("[HotUpdater]")} Failed to transform bundle ${bundlePath}: ${error}`,
    );
    return { transformed: false, occurrences: 0 };
  }
}
