import generate from "@babel/generator";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";

export const transformEnv = async <T extends Record<string, string>>(
  code: string,
  env: T,
) => {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript"],
  });

  traverse(ast as any, {
    MemberExpression(path) {
      if (
        t.isIdentifier(path.node.object, { name: "HotUpdater" }) &&
        t.isIdentifier(path.node.property)
      ) {
        const key = path.node.property.name;
        const value = env[key as keyof T];
        if (value !== undefined) {
          path.replaceWith(t.stringLiteral(value));
        }
      }
    },
  });

  const output = generate(ast as any);
  return output.code;
};
