import { parseSync, Visitor } from "oxc-parser";

/**
 * The modules `source` imports or re-exports, statically or with an
 * `import()` of a string literal or a template without substitutions: what a
 * runtime that loads it unbundled, such as Deno through an import map,
 * resolves. An `import()` of a computed specifier, such as
 * `import("dayjs/locale/" + name + ".js")`, names no module to resolve.
 * Minified code reads the same as formatted code. `fileName` gives the
 * language, such as `.ts`.
 */
export const moduleSpecifiersOf = (
  fileName: string,
  source: string,
): string[] => {
  const { errors, module, program } = parseSync(fileName, source);
  if (errors.length > 0) {
    throw new Error(
      `Could not read the imports of ${fileName}: ${errors[0]!.message}`,
    );
  }
  const dynamicImports: string[] = [];
  new Visitor({
    ImportExpression({ source: specifier }) {
      if (specifier.type === "Literal" && typeof specifier.value === "string") {
        dynamicImports.push(specifier.value);
      } else if (
        specifier.type === "TemplateLiteral" &&
        specifier.expressions.length === 0 &&
        typeof specifier.quasis[0]?.value.cooked === "string"
      ) {
        dynamicImports.push(specifier.quasis[0].value.cooked);
      }
    },
  }).visit(program);
  return [
    ...new Set([
      ...module.staticImports.map(({ moduleRequest }) => moduleRequest.value),
      ...module.staticExports.flatMap(({ entries }) =>
        entries.flatMap(({ moduleRequest }) =>
          moduleRequest === null ? [] : [moduleRequest.value],
        ),
      ),
      ...dynamicImports,
    ]),
  ];
};
