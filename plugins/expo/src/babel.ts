import type * as babelTypes from "@babel/types";

import {
  buildHotUpdaterDomProps,
  isSupportedWebViewCall,
  isWebViewJsxName,
} from "./babel-utils";

type ObjectExpressionPath = {
  node: babelTypes.ObjectExpression;
  parent: babelTypes.Node;
};

type JSXOpeningElementPath = {
  node: babelTypes.JSXOpeningElement;
};

type ProgramPath = {
  node: babelTypes.Program;
  traverse(visitor: {
    ObjectExpression?(path: ObjectExpressionPath): void;
    JSXOpeningElement?(path: JSXOpeningElementPath): void;
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

              const parent = objPath.parent;
              if (!t.isCallExpression(parent)) return;
              if (!isSupportedWebViewCall(t, parent, objPath.node)) return;

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

              const spreadElement = objPath.node.properties.find((prop) =>
                t.isSpreadElement(prop),
              ) as babelTypes.SpreadElement | undefined;

              const propIndex = objPath.node.properties.indexOf(filePathProp);
              objPath.node.properties.splice(
                propIndex,
                1,
                t.spreadElement(
                  buildHotUpdaterDomProps(
                    t,
                    fileName,
                    spreadElement && t.isIdentifier(spreadElement.argument)
                      ? spreadElement.argument
                      : undefined,
                  ),
                ),
              );
            },
            JSXOpeningElement(jsxPath) {
              if (!isWebViewJsxName(t, jsxPath.node.name)) return;

              const filePathAttr = jsxPath.node.attributes.find(
                (attr) =>
                  t.isJSXAttribute(attr) &&
                  t.isJSXIdentifier(attr.name, { name: "filePath" }) &&
                  (t.isStringLiteral(attr.value) ||
                    (t.isJSXExpressionContainer(attr.value) &&
                      t.isIdentifier(attr.value.expression))),
              );

              if (!filePathAttr || !t.isJSXAttribute(filePathAttr)) return;

              let fileName: string | undefined;
              if (
                t.isStringLiteral(filePathAttr.value) &&
                filePathAttr.value.value.endsWith(".html")
              ) {
                fileName = filePathAttr.value.value;
              } else if (
                t.isJSXExpressionContainer(filePathAttr.value) &&
                t.isIdentifier(filePathAttr.value.expression)
              ) {
                const declaredValue = filePathDeclarations.get(
                  filePathAttr.value.expression.name,
                );
                if (declaredValue) fileName = declaredValue;
              }

              if (!fileName) return;

              const spreadAttribute = jsxPath.node.attributes.find((attr) =>
                t.isJSXSpreadAttribute(attr),
              ) as babelTypes.JSXSpreadAttribute | undefined;

              const attrIndex = jsxPath.node.attributes.indexOf(filePathAttr);
              jsxPath.node.attributes.splice(
                attrIndex,
                1,
                t.jsxSpreadAttribute(
                  buildHotUpdaterDomProps(
                    t,
                    fileName,
                    spreadAttribute && t.isIdentifier(spreadAttribute.argument)
                      ? spreadAttribute.argument
                      : undefined,
                  ),
                ),
              );
            },
          });
        },
      },
    },
  };
}
