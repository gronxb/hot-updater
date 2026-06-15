import type * as babelTypes from "@babel/types";

function isWebViewExpression(
  t: typeof babelTypes,
  node: babelTypes.Node | null | undefined,
): boolean {
  return (
    (t.isIdentifier(node) &&
      (node.name === "WebView" || node.name.endsWith("WebView"))) ||
    (t.isMemberExpression(node) &&
      t.isIdentifier(node.property, { name: "WebView" }))
  );
}

function isJsxRuntimeCallee(
  t: typeof babelTypes,
  callee: babelTypes.CallExpression["callee"],
): boolean {
  if (t.isIdentifier(callee)) {
    return ["jsx", "jsxs", "jsxDEV"].some((name) => callee.name.endsWith(name));
  }

  if (t.isMemberExpression(callee)) {
    return (
      t.isIdentifier(callee.property) &&
      ["jsx", "jsxs", "jsxDEV"].includes(callee.property.name)
    );
  }

  if (t.isSequenceExpression(callee)) {
    return isJsxRuntimeCallee(
      t,
      callee.expressions[callee.expressions.length - 1],
    );
  }

  return false;
}

export function isSupportedWebViewCall(
  t: typeof babelTypes,
  callExpression: babelTypes.CallExpression,
  propsNode: babelTypes.ObjectExpression,
): boolean {
  if (callExpression.arguments[1] !== propsNode) return false;
  if (!isWebViewExpression(t, callExpression.arguments[0])) return false;

  if (
    t.isMemberExpression(callExpression.callee) &&
    t.isIdentifier(callExpression.callee.property, { name: "createElement" })
  ) {
    return true;
  }

  return isJsxRuntimeCallee(t, callExpression.callee);
}

export function buildHotUpdaterDomProps(
  t: typeof babelTypes,
  fileName: string,
  spreadIdentifier?: babelTypes.Identifier,
): babelTypes.CallExpression {
  const overrideUri = t.objectProperty(
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
  );

  const hotDomProps = spreadIdentifier
    ? [
        t.spreadElement(
          t.memberExpression(spreadIdentifier, t.identifier("dom")),
        ),
        overrideUri,
      ]
    : [overrideUri];

  const conditionalObject = t.conditionalExpression(
    t.identifier("baseURL"),
    t.objectExpression([
      t.objectProperty(t.identifier("dom"), t.objectExpression(hotDomProps)),
      t.objectProperty(t.identifier("filePath"), t.stringLiteral(fileName)),
    ]),
    t.objectExpression([
      t.objectProperty(t.identifier("filePath"), t.stringLiteral(fileName)),
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
    t.unaryExpression("void", t.numericLiteral(0)),
  );

  return t.callExpression(arrowFunction, [safeGetBaseURL]);
}

export function isWebViewJsxName(
  t: typeof babelTypes,
  name:
    | babelTypes.JSXNamespacedName
    | babelTypes.JSXMemberExpression
    | babelTypes.JSXIdentifier,
): boolean {
  if (t.isJSXIdentifier(name)) {
    return name.name === "WebView" || name.name.endsWith("WebView");
  }

  if (t.isJSXMemberExpression(name)) {
    return isWebViewJsxName(t, name.property);
  }

  return false;
}
