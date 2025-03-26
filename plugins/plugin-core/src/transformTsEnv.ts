import * as ts from "typescript";

export const transformTsEnv = <T extends Record<string, string>>(
  code: string,
  env: T,
): string => {
  const sourceFile = ts.createSourceFile(
    "temp.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
  );

  const transformer = <T extends ts.Node>(
    context: ts.TransformationContext,
  ) => {
    const visitor: ts.Visitor = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const expression = node.expression;
        const property = node.name;
        if (ts.isIdentifier(expression) && expression.text === "HotUpdater") {
          const key = property.text;
          const value = env[key];
          if (value !== undefined) {
            return ts.factory.createStringLiteral(value);
          }
        }
      }
      return ts.visitEachChild(node, visitor, context);
    };
    return (node: T) => ts.visitNode(node, visitor);
  };

  const result = ts.transform(sourceFile, [transformer as any]);
  const transformedSourceFile = result.transformed[0] as ts.SourceFile;

  const printer = ts.createPrinter();
  const transformedCode = printer.printFile(transformedSourceFile);

  return transformedCode;
};
