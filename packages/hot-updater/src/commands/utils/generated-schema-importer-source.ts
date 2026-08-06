import { parseSync } from "oxc-parser";

import { getUnshadowedRequireSources } from "./generated-schema-require-sources";

type ModuleSource = Readonly<{
  end: number;
  start: number;
  type: "Literal";
  value: unknown;
}>;
type SyntaxNode = Readonly<Record<string, unknown>>;

function getModuleSource(statement: SyntaxNode): ModuleSource | undefined {
  const specifiers = statement["specifiers"];
  const specifierKind =
    statement["type"] === "ImportDeclaration" ? "importKind" : "exportKind";
  if (
    statement[specifierKind] === "type" ||
    (Array.isArray(specifiers) &&
      specifiers.length > 0 &&
      specifiers.every(
        (specifier) =>
          isSyntaxNode(specifier) && specifier[specifierKind] === "type",
      ))
  ) {
    return undefined;
  }

  switch (statement["type"]) {
    case "ImportDeclaration":
    case "ExportAllDeclaration":
    case "ExportNamedDeclaration": {
      const moduleSource = statement["source"];
      return isModuleSource(moduleSource) ? moduleSource : undefined;
    }
    default:
      return undefined;
  }
}

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return typeof value === "object" && value !== null;
}

function isModuleSource(value: unknown): value is ModuleSource {
  return (
    isSyntaxNode(value) &&
    value["type"] === "Literal" &&
    typeof value["start"] === "number" &&
    typeof value["end"] === "number"
  );
}

export function replaceGeneratedSchemaModuleSpecifiers(
  source: string,
  resolveVirtualModuleId: (request: string) => string | undefined,
  parseAsCommonJs = false,
): string {
  const result = parseSync("generated-schema-import.ts", source, {
    astType: "ts",
    lang: "ts",
    preserveParens: false,
    sourceType: parseAsCommonJs ? "commonjs" : "unambiguous",
    showSemanticErrors: false,
  });
  if (result.errors.length > 0) return source;

  const moduleSources = [
    ...result.program.body.flatMap((statement) => {
      const moduleSource = isSyntaxNode(statement)
        ? getModuleSource(statement)
        : undefined;
      return moduleSource ? [moduleSource] : [];
    }),
    ...getUnshadowedRequireSources(result.program),
  ];
  const virtualModuleIds = new Map<string, string | undefined>();

  return moduleSources
    .flatMap((moduleSource) => {
      if (typeof moduleSource.value !== "string") return [];
      const request = moduleSource.value;
      if (!virtualModuleIds.has(request)) {
        virtualModuleIds.set(request, resolveVirtualModuleId(request));
      }
      const virtualModuleId = virtualModuleIds.get(request);
      return virtualModuleId ? [{ moduleSource, virtualModuleId }] : [];
    })
    .sort((left, right) => right.moduleSource.start - left.moduleSource.start)
    .reduce(
      (updatedSource, { moduleSource, virtualModuleId }) =>
        `${updatedSource.slice(0, moduleSource.start)}${JSON.stringify(
          virtualModuleId,
        )}${updatedSource.slice(moduleSource.end)}`,
      source,
    );
}
