import {
  analyzeRequireScopes,
  isRequireShadowed,
  type RequireScopeAnalysis,
} from "./generated-schema-require-scopes";

type ModuleSource = Readonly<{
  end: number;
  start: number;
  type: "Literal";
  value: unknown;
}>;
type SyntaxNode = Readonly<Record<string, unknown>>;

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

function getRequireSource(node: SyntaxNode): ModuleSource | undefined {
  const callee = node["callee"];
  const args = node["arguments"];
  if (
    node["type"] !== "CallExpression" ||
    !isSyntaxNode(callee) ||
    callee["type"] !== "Identifier" ||
    callee["name"] !== "require" ||
    !Array.isArray(args) ||
    args.length !== 1
  ) {
    return undefined;
  }
  return isModuleSource(args[0]) ? args[0] : undefined;
}

function getRequireSources(
  value: unknown,
  analysis: RequireScopeAnalysis,
): readonly ModuleSource[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => getRequireSources(item, analysis));
  }
  if (!isSyntaxNode(value)) return [];

  const source = getRequireSource(value);
  const position = value["start"];
  return [
    ...(source &&
    !analysis.wrapperRequireWritten &&
    typeof position === "number" &&
    !isRequireShadowed(position, analysis)
      ? [source]
      : []),
    ...Object.values(value).flatMap((child) =>
      getRequireSources(child, analysis),
    ),
  ];
}

export function getUnshadowedRequireSources(
  program: unknown,
): readonly ModuleSource[] {
  return getRequireSources(program, analyzeRequireScopes(program));
}
