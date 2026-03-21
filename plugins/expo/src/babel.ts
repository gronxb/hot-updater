import type * as babelTypes from "@babel/types";

type ObjectExpressionPath = {
  node: babelTypes.ObjectExpression;
  parent: babelTypes.Node;
};

type ProgramPath = {
  node: babelTypes.Program;
  traverse(visitor: {
    ObjectExpression(path: ObjectExpressionPath): void;
  }): void;
};

type HotUpdaterBabelPlugin = {
  name: string;
  visitor: {
    Program: {
      exit(programPath: ProgramPath): void;
    };
  };
};

/**
 * Hot Updater Babel Plugin
 *
 * This plugin transforms Expo DOM component filePath to overrideUri for OTA
 * updates.
 */
export default function ({
  types: t,
}: {
  types: typeof babelTypes;
}): HotUpdaterBabelPlugin {
  return {
    name: "hot-updater-babel-plugin",
    visitor: {
      Program: {
        exit(programPath) {
          // Collect filePath declarations
          const filePathDeclarations = new Map<string, string>();

          programPath.node.body.forEach((node) => {
            if (t.isVariableDeclaration(node) && node.declarations.length > 0) {
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

              // Find spread element
              const spreadElement = objPath.node.properties.find((prop) =>
                t.isSpreadElement(prop),
              ) as babelTypes.SpreadElement | undefined;

              // Create IIFE: ((baseURL) => baseURL ? { dom: {...}, filePath: "..." } : { filePath: "..." })(HotUpdaterGetBaseURL())
              const conditionalObject = t.conditionalExpression(
                t.identifier("baseURL"),
                // If baseURL exists: { dom: { overrideUri: [...].join("/") }, filePath: "hash.html" }
                t.objectExpression([
                  t.objectProperty(
                    t.identifier("dom"),
                    t.objectExpression(
                      spreadElement && t.isIdentifier(spreadElement.argument)
                        ? [
                            t.spreadElement(
                              t.memberExpression(
                                spreadElement.argument,
                                t.identifier("dom"),
                              ),
                            ),
                            t.objectProperty(
                              t.identifier("overrideUri"),
                              t.callExpression(
                                t.memberExpression(
                                  t.arrayExpression([
                                    t.identifier("baseURL"),
                                    t.stringLiteral("www.bundle"),
                                    t.stringLiteral(fileName),
                                  ]),
                                  t.identifier("join"),
                                ),
                                [t.stringLiteral("/")],
                              ),
                            ),
                          ]
                        : [
                            t.objectProperty(
                              t.identifier("overrideUri"),
                              t.callExpression(
                                t.memberExpression(
                                  t.arrayExpression([
                                    t.identifier("baseURL"),
                                    t.stringLiteral("www.bundle"),
                                    t.stringLiteral(fileName),
                                  ]),
                                  t.identifier("join"),
                                ),
                                [t.stringLiteral("/")],
                              ),
                            ),
                          ],
                    ),
                  ),
                  t.objectProperty(
                    t.identifier("filePath"),
                    t.stringLiteral(fileName),
                  ),
                ]),
                // Else: { filePath: "hash.html" }
                t.objectExpression([
                  t.objectProperty(
                    t.identifier("filePath"),
                    t.stringLiteral(fileName),
                  ),
                ]),
              );

              const arrowFunction = t.arrowFunctionExpression(
                [t.identifier("baseURL")],
                conditionalObject,
              );

              const safeGetBaseURL = t.conditionalExpression(
                t.logicalExpression(
                  "&&",
                  t.binaryExpression(
                    "!==",
                    t.unaryExpression(
                      "typeof",
                      t.identifier("globalThis"),
                      true,
                    ),
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
                t.unaryExpression("void", t.numericLiteral(0)),
              );

              const iifeCall = t.callExpression(arrowFunction, [
                safeGetBaseURL,
              ]);

              // Replace only filePath so existing spread/forwarded props keep
              // their original order and override behavior.
              const propIndex = objPath.node.properties.indexOf(filePathProp);
              objPath.node.properties.splice(
                propIndex,
                1,
                t.spreadElement(iifeCall),
              );
            },
          });
        },
      },
    },
  };
}
