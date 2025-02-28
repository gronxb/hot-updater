import generate from "@babel/generator";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";

export const defineRegion = async (code: string, region: string) => {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript"],
  });

  traverse(ast as any, {
    MemberExpression(path) {
      if (
        t.isIdentifier(path.node.object, { name: "HotUpdater" }) &&
        t.isIdentifier(path.node.property, { name: "S3_REGION" })
      ) {
        path.replaceWith(t.stringLiteral(region));
      }
    },
  });

  const output = generate(ast as any);
  return output.code;
};
