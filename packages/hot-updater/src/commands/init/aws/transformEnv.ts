import crypto from "crypto";
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";

export const generateInternalToken = () => {
  return crypto.randomBytes(32).toString("hex");
};

export const transformEnv = async (
  code: string,
  {
    S3_REGION,
    INTERNAL_AUTH_TOKEN,
  }: {
    S3_REGION?: string;
    INTERNAL_AUTH_TOKEN?: string;
  },
) => {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript"],
  });

  traverse(ast as any, {
    MemberExpression(path) {
      if (
        S3_REGION &&
        t.isIdentifier(path.node.object, { name: "HotUpdater" }) &&
        t.isIdentifier(path.node.property, { name: "S3_REGION" })
      ) {
        path.replaceWith(t.stringLiteral(S3_REGION));
      }
      if (
        INTERNAL_AUTH_TOKEN &&
        t.isIdentifier(path.node.object, { name: "HotUpdater" }) &&
        t.isIdentifier(path.node.property, { name: "INTERNAL_AUTH_TOKEN" })
      ) {
        path.replaceWith(t.stringLiteral(INTERNAL_AUTH_TOKEN));
      }
    },
  });

  const output = generate(ast as any);
  return output.code;
};
