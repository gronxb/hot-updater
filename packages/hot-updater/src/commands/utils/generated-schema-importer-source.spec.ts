import { describe, expect, it } from "vitest";

import { replaceGeneratedSchemaModuleSpecifiers } from "./generated-schema-importer-source";

const replaceMissingSchema = (source: string): string =>
  replaceGeneratedSchemaModuleSpecifiers(source, (request) =>
    request === "./generated/prisma" ? "virtual:generated-schema" : undefined,
  );

describe("generated schema importer source", () => {
  it.each([
    "const require = loader;",
    "const { require } = loader;",
    "const [require] = loaders;",
    "export const require = loader;",
    "export function require() {}",
    "export class require {}",
    'import { loader as require } from "./loader";',
    "require = loader;",
    "for (require of loaders) {}",
    "for (require in loaders) {}",
  ])("preserves calls when require is bound or written by %s", (binding) => {
    const source = [
      binding,
      'const client = require("./generated/prisma");',
    ].join("\n");

    expect(replaceMissingSchema(source)).toBe(source);
  });

  it.each([
    "function load(require) { return require('./other'); }",
    "function load() { const require = loader; return require('./other'); }",
    "try {} catch (require) { require('./other'); }",
    "{ const require = loader; require('./other'); }",
    "for (const require of loaders) { require('./other'); }",
    "class Loader { static { var require = loader; require('./other'); } }",
    "namespace Loader { var require = loader; require('./other'); }",
  ])("rewrites an unrelated top-level require after %s", (localBinding) => {
    const source = [
      localBinding,
      'const client = require("./generated/prisma");',
    ].join("\n");

    expect(replaceMissingSchema(source)).toBe(
      [
        localBinding,
        'const client = require("virtual:generated-schema");',
      ].join("\n"),
    );
  });

  it("keeps the switch discriminant outside the case lexical scope", () => {
    const source = [
      'switch (require("./generated/prisma")) {',
      "  case 1: let require; break;",
      "}",
    ].join("\n");

    expect(replaceMissingSchema(source)).toContain(
      'switch (require("virtual:generated-schema"))',
    );
  });

  it("shares the switch lexical scope across case clauses", () => {
    const source = [
      "switch (value) {",
      '  case require("./generated/prisma"): break;',
      "  case 2: let require; break;",
      "}",
    ].join("\n");

    expect(replaceMissingSchema(source)).toBe(source);
  });

  it.each([
    'import type { PrismaClient } from "./generated/prisma";',
    'import { type PrismaClient } from "./generated/prisma";',
    'export type { PrismaClient } from "./generated/prisma";',
    'export { type PrismaClient } from "./generated/prisma";',
  ])("preserves an erased type-only module source in %s", (source) => {
    expect(replaceMissingSchema(source)).toBe(source);
  });

  it("rewrites a module source with runtime and type-only specifiers", () => {
    expect(
      replaceMissingSchema(
        'import { PrismaClient, type Prisma } from "./generated/prisma";',
      ),
    ).toBe(
      'import { PrismaClient, type Prisma } from "virtual:generated-schema";',
    );
  });

  it.each([
    "declare const require: NodeRequire;",
    "declare function require(request: string): unknown;",
  ])("ignores the erased declaration %s", (declaration) => {
    expect(
      replaceMissingSchema(
        `${declaration}\nconst client = require("./generated/prisma");`,
      ),
    ).toBe(
      `${declaration}\nconst client = require("virtual:generated-schema");`,
    );
  });

  it("rewrites an unshadowed top-level CommonJS require", () => {
    expect(
      replaceMissingSchema('const client = require("./generated/prisma");'),
    ).toBe('const client = require("virtual:generated-schema");');
  });

  it("applies mixed import and require replacements from right to left", () => {
    const source = [
      'const schema = require("./generated/prisma");',
      'import client from "./generated/client";',
    ].join("\n");

    expect(
      replaceGeneratedSchemaModuleSpecifiers(source, (request) => {
        switch (request) {
          case "./generated/prisma":
            return "virtual:p";
          case "./generated/client":
            return "virtual:generated-schema-client-with-a-long-name";
        }
        return undefined;
      }),
    ).toBe(
      [
        'const schema = require("virtual:p");',
        'import client from "virtual:generated-schema-client-with-a-long-name";',
      ].join("\n"),
    );
  });

  it("keeps body var bindings out of default parameter initializers", () => {
    const source = [
      'function load(client = require("./generated/prisma")) {',
      "  var require = loader;",
      '  return require("./generated/prisma");',
      "}",
    ].join("\n");

    expect(replaceMissingSchema(source)).toBe(
      [
        'function load(client = require("virtual:generated-schema")) {',
        "  var require = loader;",
        '  return require("./generated/prisma");',
        "}",
      ].join("\n"),
    );
  });

  it("preserves a require parameter binding in its default initializer", () => {
    const source = [
      'function load(require = require("./generated/prisma")) {',
      "  return require;",
      "}",
    ].join("\n");

    expect(replaceMissingSchema(source)).toBe(source);
  });

  it.each([
    'const client = require("./generated/prisma").PrismaClient;',
    [
      "function createClient() {",
      '  return require("./generated/prisma").PrismaClient;',
      "}",
    ].join("\n"),
  ])("rewrites an unshadowed require inside an expression", (source) => {
    expect(replaceMissingSchema(source)).toContain(
      'require("virtual:generated-schema")',
    );
  });
});
