import { describe, expect, it } from "vitest";

import { moduleSpecifiersOf } from "./moduleSpecifiers";

describe("moduleSpecifiersOf", () => {
  it("reads the imports, re-exports, and literal import() of minified code as of formatted code, and skips a computed import()", () => {
    const formatted = [
      'import { createHotUpdater } from "@hot-updater/server";',
      'import "./side-effect.mjs";',
      'import type { Plugin } from "@hot-updater/server/plugins";',
      'export { notes } from "./notes.mjs";',
      'export * from "@hot-updater/core";',
      'const lazy = () => import("./lazy.mjs");',
      "const template = () => import(`./template.mjs`);",
      "const computed = (name: string) => import(name);",
      'const locale = (name: string) => import("dayjs/locale/" + name + ".js");',
      "const substituted = (name: string) => import(`./locales/${name}.mjs`);",
      'const text = "import(\\"./not-an-import.mjs\\")";',
      "",
    ].join("\n");
    // esbuild leaves an import() of a computed specifier as it is.
    const minified =
      'import{createHotUpdater as a}from"@hot-updater/server";import"./side-effect.mjs";export{notes}from"./notes.mjs";export*from"@hot-updater/core";const b=()=>import("./lazy.mjs"),t=()=>import(`./template.mjs`),c=d=>import(d),l=n=>import("dayjs/locale/"+n+".js"),s=n=>import(`./locales/${n}.mjs`),e="import(\\"./not-an-import.mjs\\")";';

    const expected = [
      "@hot-updater/server",
      "./side-effect.mjs",
      "./notes.mjs",
      "@hot-updater/core",
      "./lazy.mjs",
      "./template.mjs",
    ];
    expect(moduleSpecifiersOf("formatted.ts", formatted).sort()).toEqual(
      [...expected, "@hot-updater/server/plugins"].sort(),
    );
    expect(moduleSpecifiersOf("minified.mjs", minified).sort()).toEqual(
      expected.sort(),
    );
  });

  it("names the file it cannot parse", () => {
    expect(() => moduleSpecifiersOf("broken.mjs", "import {")).toThrow(
      /^Could not read the imports of broken\.mjs: /u,
    );
  });
});
