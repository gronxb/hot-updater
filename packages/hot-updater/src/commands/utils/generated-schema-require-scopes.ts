type SyntaxNode = Readonly<Record<string, unknown>>;
type RequireScope = {
  end: number;
  hasBinding: boolean;
  start: number;
};

export type RequireScopeAnalysis = Readonly<{
  scopes: readonly RequireScope[];
  wrapperRequireWritten: boolean;
}>;

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return typeof value === "object" && value !== null;
}

function hasRequireBinding(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRequireBinding);
  if (!isSyntaxNode(value)) return false;

  switch (value["type"]) {
    case "Identifier":
      return value["name"] === "require";
    case "ArrayPattern":
      return hasRequireBinding(value["elements"]);
    case "AssignmentPattern":
      return hasRequireBinding(value["left"]);
    case "ObjectPattern":
      return hasRequireBinding(value["properties"]);
    case "Property":
      return hasRequireBinding(value["value"]);
    case "RestElement":
      return hasRequireBinding(value["argument"]);
    case "TSParameterProperty":
      return hasRequireBinding(value["parameter"]);
    default:
      return false;
  }
}

function nodePosition(value: unknown, key: "end" | "start"): number {
  if (!isSyntaxNode(value)) return 0;
  const position = value[key];
  return typeof position === "number" ? position : 0;
}

function createRequireScope(
  value: unknown,
  scopes: RequireScope[],
): RequireScope {
  const scope = {
    end: nodePosition(value, "end"),
    hasBinding: false,
    start: nodePosition(value, "start"),
  };
  scopes.push(scope);
  return scope;
}

function addRequireBinding(scope: RequireScope, value: unknown): void {
  if (hasRequireBinding(value)) scope.hasBinding = true;
}

function collectFunctionRequireScopes(
  value: SyntaxNode,
  outerScope: RequireScope,
  scopes: RequireScope[],
  bindNameInOuterScope: boolean,
): void {
  if (bindNameInOuterScope && value["declare"] !== true) {
    addRequireBinding(outerScope, value["id"]);
  }

  const parameterScope = createRequireScope(value, scopes);
  addRequireBinding(parameterScope, value["id"]);
  addRequireBinding(parameterScope, value["params"]);

  for (const [key, child] of Object.entries(value)) {
    if (key !== "body") {
      collectRequireScopes(child, parameterScope, parameterScope, scopes);
    }
  }

  const body = value["body"];
  if (isSyntaxNode(body) && body["type"] === "BlockStatement") {
    const bodyScope = createRequireScope(body, scopes);
    for (const child of Object.values(body)) {
      collectRequireScopes(child, bodyScope, bodyScope, scopes);
    }
    return;
  }

  collectRequireScopes(body, parameterScope, parameterScope, scopes);
}

function collectRequireScopes(
  value: unknown,
  currentScope: RequireScope,
  currentFunctionScope: RequireScope,
  scopes: RequireScope[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRequireScopes(item, currentScope, currentFunctionScope, scopes);
    }
    return;
  }
  if (!isSyntaxNode(value)) return;

  let childScope = currentScope;
  let childFunctionScope = currentFunctionScope;
  switch (value["type"]) {
    case "ArrowFunctionExpression":
    case "FunctionExpression": {
      collectFunctionRequireScopes(value, currentScope, scopes, false);
      return;
    }
    case "FunctionDeclaration": {
      collectFunctionRequireScopes(value, currentScope, scopes, true);
      return;
    }
    case "ClassExpression": {
      childScope = createRequireScope(value, scopes);
      addRequireBinding(childScope, value["id"]);
      break;
    }
    case "ClassDeclaration": {
      if (value["declare"] !== true) {
        addRequireBinding(currentScope, value["id"]);
      }
      childScope = createRequireScope(value, scopes);
      addRequireBinding(childScope, value["id"]);
      break;
    }
    case "BlockStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "ForStatement":
      childScope = createRequireScope(value, scopes);
      break;
    case "SwitchStatement": {
      childScope = createRequireScope(value, scopes);
      const cases = value["cases"];
      const firstCase = Array.isArray(cases) ? cases[0] : undefined;
      if (isSyntaxNode(firstCase)) {
        childScope.start = nodePosition(firstCase, "start");
      }
      break;
    }
    case "StaticBlock":
    case "TSModuleBlock":
      childScope = createRequireScope(value, scopes);
      childFunctionScope = childScope;
      break;
    case "CatchClause":
      childScope = createRequireScope(value, scopes);
      addRequireBinding(childScope, value["param"]);
      break;
    case "VariableDeclaration": {
      if (value["declare"] === true) break;
      const bindingScope =
        value["kind"] === "var" ? currentFunctionScope : currentScope;
      const declarations = value["declarations"];
      if (Array.isArray(declarations)) {
        for (const declaration of declarations) {
          if (isSyntaxNode(declaration)) {
            addRequireBinding(bindingScope, declaration["id"]);
          }
        }
      }
      break;
    }
    case "ImportDeclaration": {
      if (value["importKind"] === "type") break;
      const specifiers = value["specifiers"];
      if (Array.isArray(specifiers)) {
        for (const specifier of specifiers) {
          if (isSyntaxNode(specifier) && specifier["importKind"] !== "type") {
            addRequireBinding(currentScope, specifier["local"]);
          }
        }
      }
      break;
    }
    case "TSEnumDeclaration":
    case "TSImportEqualsDeclaration":
    case "TSModuleDeclaration":
      if (value["declare"] !== true && value["importKind"] !== "type") {
        addRequireBinding(currentScope, value["id"] ?? value["name"]);
      }
      break;
  }

  for (const child of Object.values(value)) {
    collectRequireScopes(child, childScope, childFunctionScope, scopes);
  }
}

function isShadowed(
  position: number,
  scopes: readonly RequireScope[],
): boolean {
  return scopes.some(
    (scope) =>
      scope.hasBinding && position >= scope.start && position < scope.end,
  );
}

function hasUnshadowedRequireWrite(
  value: unknown,
  scopes: readonly RequireScope[],
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasUnshadowedRequireWrite(item, scopes));
  }
  if (!isSyntaxNode(value)) return false;

  let writeTarget: unknown;
  switch (value["type"]) {
    case "AssignmentExpression":
      writeTarget = value["left"];
      break;
    case "ForInStatement":
    case "ForOfStatement":
      writeTarget = value["left"];
      break;
    case "UpdateExpression":
      writeTarget = value["argument"];
      break;
  }
  if (
    hasRequireBinding(writeTarget) &&
    !isShadowed(nodePosition(value, "start"), scopes)
  ) {
    return true;
  }

  return Object.values(value).some((child) =>
    hasUnshadowedRequireWrite(child, scopes),
  );
}

export function analyzeRequireScopes(program: unknown): RequireScopeAnalysis {
  if (!isSyntaxNode(program)) {
    return { scopes: [], wrapperRequireWritten: false };
  }
  const scopes: RequireScope[] = [];
  const programScope = createRequireScope(program, scopes);
  collectRequireScopes(program["body"], programScope, programScope, scopes);
  return {
    scopes,
    wrapperRequireWritten: hasUnshadowedRequireWrite(program, scopes),
  };
}

export function isRequireShadowed(
  position: number,
  analysis: RequireScopeAnalysis,
): boolean {
  return isShadowed(position, analysis.scopes);
}
