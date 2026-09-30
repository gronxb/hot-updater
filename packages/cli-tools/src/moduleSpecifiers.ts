import { parseSync } from "oxc-parser";

/**
 * The modules `source` imports or re-exports, statically or with an
 * `import()` of a string literal: what a runtime that loads it unbundled,
 * such as Deno through an import map, resolves. Minified code reads the same
 * as formatted code. `fileName` gives the language, such as `.ts`.
 */
export const moduleSpecifiersOf = (
  fileName: string,
  source: string,
): string[] => {
  const { errors, module } = parseSync(fileName, source);
  if (errors.length > 0) {
    throw new Error(
      `Could not read the imports of ${fileName}: ${errors[0]!.message}`,
    );
  }
  return [
    ...new Set([
      ...module.staticImports.map(({ moduleRequest }) => moduleRequest.value),
      ...module.staticExports.flatMap(({ entries }) =>
        entries.flatMap(({ moduleRequest }) =>
          moduleRequest === null ? [] : [moduleRequest.value],
        ),
      ),
      ...module.dynamicImports.flatMap(({ moduleRequest }) => {
        const literal = /^(["'])(.*)\1$/su.exec(
          source.slice(moduleRequest.start, moduleRequest.end),
        );
        return literal === null ? [] : [literal[2]!];
      }),
    ]),
  ];
};
