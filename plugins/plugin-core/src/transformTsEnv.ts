import { Project, SyntaxKind } from "ts-morph";

export const transformTsEnv = <T extends Record<string, string>>(
  code: string,
  env: T,
): string => {
  const project = new Project();
  const sourceFile = project.createSourceFile("temp.ts", code);

  sourceFile.forEachDescendant((node) => {
    if (node.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = node.asKind(SyntaxKind.PropertyAccessExpression);
      if (!propAccess) return;

      const expression = propAccess.getExpression();
      if (expression.getKind() !== SyntaxKind.Identifier) return;

      const identifier = expression.asKind(SyntaxKind.Identifier);
      if (!identifier || identifier.getText() !== "HotUpdater") return;

      const propertyName = propAccess.getName();
      const value = env[propertyName];

      if (value !== undefined) {
        propAccess.replaceWithText(`"${value}"`);
      }
    }
  });

  return sourceFile.getFullText();
};
