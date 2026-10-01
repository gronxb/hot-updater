import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSync, Visitor } from "oxc-parser";
import { describe, expect, it } from "vitest";

import config from "../tsdown.config";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const packageJson = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
) as Readonly<Record<string, unknown>>;

/** The modules `file` imports or re-exports, statically or with `import()`. */
const moduleSpecifiersOf = (file: string): string[] => {
  const { errors, module, program } = parseSync(
    file,
    readFileSync(file, "utf8"),
  );
  expect(errors, file).toEqual([]);
  const dynamicImports: string[] = [];
  new Visitor({
    ImportExpression({ source }) {
      if (source.type === "Literal" && typeof source.value === "string") {
        dynamicImports.push(source.value);
      }
    },
  }).visit(program);
  return [
    ...module.staticImports.map(({ moduleRequest }) => moduleRequest.value),
    ...module.staticExports.flatMap(({ entries }) =>
      entries.flatMap(({ moduleRequest }) =>
        moduleRequest === null ? [] : [moduleRequest.value],
      ),
    ),
    ...dynamicImports,
  ];
};

/** The files that build into dist: everything in src but the specs. */
const sources = readdirSync(join(packageRoot, "src"), {
  encoding: "utf8",
  recursive: true,
}).filter((file) => /\.tsx?$/.test(file) && !/\.spec\.tsx?$/.test(file));

// The device and the server both run @hot-updater/protocol, so it installs
// nothing beside itself: a React Native app gets no server package through
// it. What it uses from another package is bundled into dist.
describe("@hot-updater/protocol", () => {
  it("has no dependencies", () => {
    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      expect(packageJson[field] ?? {}, field).toEqual({});
    }
  });

  it("imports only its own modules and the packages its build bundles", () => {
    const bundled = config.flatMap((entry) => entry.deps?.onlyBundle ?? []);
    const imported = sources.flatMap((file) =>
      moduleSpecifiersOf(join(packageRoot, "src", file))
        .filter((specifier) => !specifier.startsWith("."))
        .map((specifier) => ({ file, specifier })),
    );

    expect(
      imported.filter(({ specifier }) => !bundled.includes(specifier)),
    ).toEqual([]);
    expect(sources.length).toBeGreaterThan(0);
  });
});
