import * as fs from "node:fs/promises";
import * as path from "node:path";
import generate from "@babel/generator";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import fg from "fast-glob";

/**
 * List of DOM component names to transform
 * These are Expo DOM components that use filePath prop
 */
const DOM_COMPONENT_NAMES = [
  "WebView",
  "dom.WebView",
  // Add other DOM component types as needed
];

/**
 * Transforms Expo DOM components in a JavaScript/TypeScript file
 * Replaces filePath="<hash>.html" with overrideUri={HotUpdater.getBaseURL() + 'www.bundle/' + '<hash>.html'}
 *
 * @param filePath Path to the file to transform
 * @returns true if the file was transformed, false if no changes were made
 */
export async function transformDOMComponents(
  filePath: string,
): Promise<boolean> {
  const code = await fs.readFile(filePath, "utf-8");

  const ast = parser.parse(code, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });

  let transformed = false;

  // @ts-expect-error - Babel type version mismatch
  traverse(ast, {
    JSXOpeningElement(path) {
      const elementName = getElementName(path.node.name);

      if (!DOM_COMPONENT_NAMES.includes(elementName)) {
        return;
      }

      const filePathAttr = path.node.attributes.find(
        (attr) =>
          t.isJSXAttribute(attr) &&
          t.isJSXIdentifier(attr.name) &&
          attr.name.name === "filePath",
      );

      if (!filePathAttr || !t.isJSXAttribute(filePathAttr)) {
        return;
      }

      const value = filePathAttr.value;
      if (!t.isStringLiteral(value)) {
        return;
      }

      const fileName = value.value;

      // Create new overrideUri attribute with expression:
      // [HotUpdater.getBaseURL(), 'www.bundle', '<fileName>'].join('/')
      const newAttr = t.jsxAttribute(
        t.jsxIdentifier("overrideUri"),
        t.jsxExpressionContainer(
          t.callExpression(
            t.memberExpression(
              t.arrayExpression([
                t.callExpression(
                  t.memberExpression(
                    t.identifier("HotUpdater"),
                    t.identifier("getBaseURL"),
                  ),
                  [],
                ),
                t.stringLiteral("www.bundle"),
                t.stringLiteral(fileName),
              ]),
              t.identifier("join"),
            ),
            [t.stringLiteral("/")],
          ),
        ),
      );

      // Remove filePath, add overrideUri
      const attrIndex = path.node.attributes.indexOf(filePathAttr);
      path.node.attributes.splice(attrIndex, 1, newAttr);

      transformed = true;
    },
  });

  if (transformed) {
    // Check if HotUpdater is already imported
    let hasImport = false;
    // @ts-expect-error - Babel type version mismatch
    traverse(ast, {
      ImportDeclaration(path) {
        if (path.node.source.value === "@hot-updater/react-native") {
          // Check if HotUpdater is in the imports
          hasImport = path.node.specifiers.some(
            (spec) =>
              t.isImportSpecifier(spec) &&
              t.isIdentifier(spec.imported) &&
              spec.imported.name === "HotUpdater",
          );
        }
      },
    });

    // Add import if not present
    if (!hasImport) {
      const importDecl = t.importDeclaration(
        [
          t.importSpecifier(
            t.identifier("HotUpdater"),
            t.identifier("HotUpdater"),
          ),
        ],
        t.stringLiteral("@hot-updater/react-native"),
      );
      // @ts-expect-error - Babel type version mismatch
      ast.program.body.unshift(importDecl);
    }

    // @ts-expect-error - Babel type version mismatch
    const output = generate(ast, {}, code);
    await fs.writeFile(filePath, output.code, "utf-8");
  }

  return transformed;
}

/**
 * Gets the element name from a JSX element name node
 * Handles both simple identifiers (WebView) and member expressions (dom.WebView)
 */
function getElementName(name: t.JSXOpeningElement["name"]): string {
  if (t.isJSXIdentifier(name)) {
    return name.name;
  }
  if (t.isJSXMemberExpression(name)) {
    // Handle dom.WebView
    const object = getElementName(name.object as t.JSXIdentifier);
    return `${object}.${name.property.name}`;
  }
  return "";
}

/**
 * Transforms all JavaScript/TypeScript files in a directory
 * Searches for .js, .jsx, .ts, .tsx files and transforms Expo DOM components
 *
 * @param buildPath Path to the build output directory
 * @returns Number of files that were transformed
 */
export async function transformBuildDirectory(
  buildPath: string,
): Promise<number> {
  // Find all JS/TS files in the build directory, excluding maps and node_modules
  const files = await fg(["**/*.{js,jsx,ts,tsx}"], {
    cwd: buildPath,
    absolute: true,
    ignore: ["**/*.map", "**/node_modules/**"],
  });

  let transformedCount = 0;

  for (const file of files) {
    try {
      const wasTransformed = await transformDOMComponents(file);
      if (wasTransformed) {
        transformedCount++;
      }
    } catch (error) {
      // Log error but continue processing other files
      console.warn(
        `[hot-updater] Warning: Failed to transform ${path.relative(buildPath, file)}: ${error}`,
      );
    }
  }

  return transformedCount;
}
