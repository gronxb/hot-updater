import {
  parseSync,
  Visitor,
  type ArrayExpression,
  type BindingIdentifier,
  type BindingPattern,
  type BindingRestElement,
  type CallExpression,
  type Expression,
  type FormalParameterRest,
  type ImportDeclaration,
  type ModuleExportName,
  type ObjectProperty,
  type ObjectPropertyKind,
  type ParamPattern,
  type Program,
  type StringLiteral,
  type VariableDeclaration,
  type VariableDeclarator,
} from "oxc-parser";

import type { Codemod, CodemodResult } from "./runCodemod";
import {
  applyTextEdits,
  insertListItemAfter,
  lineBreakOf,
  lineEnd,
  locate,
  removeListItem,
  type Span,
  type TextEdit,
} from "./sourceText";

const SERVER_MODULE = "@hot-updater/server";

/** The built-in plugins this codemod adds, by factory name, in import order. */
const PLUGIN_MODULES = {
  apiKeys: "@hot-updater/server/plugins/api-keys",
  insights: "@hot-updater/server/plugins/insights",
} as const;

type PluginName = keyof typeof PLUGIN_MODULES;

const PLUGIN_NAMES = Object.keys(PLUGIN_MODULES) as PluginName[];

type Problem = { readonly offset: number; readonly message: string };

type CallRewrite = {
  readonly edits: readonly TextEdit[];
  readonly plugins: readonly PluginName[];
};

type ClientAccessPolicy =
  | { readonly type: "migrated" }
  | {
      readonly type: "public";
      readonly value: Expression;
      readonly quote: string;
    }
  | { readonly type: "api-key"; readonly headerName: string | undefined };

/** A top-level `require()` declaration, where CommonJS files get their imports. */
type RequireDeclaration = {
  readonly statement: VariableDeclaration;
  readonly declarator: VariableDeclarator;
  readonly source: StringLiteral;
};

const problem = (offset: number, message: string): Problem => ({
  offset,
  message,
});

const isProblem = <T extends object>(value: T | Problem): value is Problem =>
  "message" in value;

/** The last item that matches; `Array#findLast` needs a newer library target. */
const findLast = <T>(items: readonly T[], match: (item: T) => boolean) => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (match(items[index]!)) return items[index];
  }
  return undefined;
};

/** Strips what changes no value: `{ ... } as const`, `satisfies`, `!`. */
const unwrap = (expression: Expression): Expression => {
  let current = expression;
  while (
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "ParenthesizedExpression"
  ) {
    current = current.expression;
  }
  return current;
};

const isStringLiteral = (node: {
  readonly type: string;
}): node is StringLiteral =>
  node.type === "Literal" && typeof (node as StringLiteral).value === "string";

const moduleExportName = (name: ModuleExportName): string =>
  name.type === "Literal" ? name.value : name.name;

const propertyName = (property: ObjectProperty): string | null => {
  const { key } = property;
  if (!property.computed && key.type === "Identifier") return key.name;
  return key.type === "Literal" ? String(key.value) : null;
};

/** A `key: value` property: not a method, getter, or shorthand. */
const isDataProperty = (
  property: ObjectPropertyKind,
): property is ObjectProperty =>
  property.type === "Property" &&
  property.kind === "init" &&
  !property.method &&
  !property.shorthand;

/** The `"module"` of a `require("module")` call. */
const requiredModule = (
  expression: Expression | null | undefined,
): StringLiteral | null => {
  if (
    expression?.type !== "CallExpression" ||
    expression.callee.type !== "Identifier" ||
    expression.callee.name !== "require"
  ) {
    return null;
  }
  const [argument] = expression.arguments;
  return argument && isStringLiteral(argument) ? argument : null;
};

/** The local name an object pattern binds for `name`: `{ name: local }`. */
const destructuredName = (pattern: BindingPattern, name: string) => {
  if (pattern.type !== "ObjectPattern") return undefined;
  for (const property of pattern.properties) {
    if (
      property.type === "Property" &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.key.name === name &&
      property.value.type === "Identifier"
    ) {
      return property.value.name;
    }
  }
  return undefined;
};

/** Adds the names a declaration pattern binds. */
const addBoundNames = (
  pattern:
    | BindingPattern
    | BindingRestElement
    | FormalParameterRest
    | null
    | undefined,
  names: Set<string>,
): void => {
  switch (pattern?.type) {
    case "Identifier":
      names.add(pattern.name);
      return;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        addBoundNames(
          property.type === "RestElement" ? property.argument : property.value,
          names,
        );
      }
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) addBoundNames(element, names);
      return;
    case "AssignmentPattern":
      addBoundNames(pattern.left, names);
      return;
    case "RestElement":
      addBoundNames(pattern.argument, names);
      return;
  }
};

/** Every value name the file declares, in any scope. */
const declaredNames = (program: Program): Set<string> => {
  const names = new Set<string>();
  const addFunction = (node: {
    readonly id: BindingIdentifier | null;
    readonly params: readonly ParamPattern[];
  }) => {
    if (node.id) names.add(node.id.name);
    for (const param of node.params) {
      addBoundNames(
        param.type === "TSParameterProperty" ? param.parameter : param,
        names,
      );
    }
  };
  new Visitor({
    VariableDeclarator: (node) => addBoundNames(node.id, names),
    FunctionDeclaration: addFunction,
    FunctionExpression: addFunction,
    ArrowFunctionExpression: addFunction,
    ClassDeclaration: (node) => node.id && names.add(node.id.name),
    ClassExpression: (node) => node.id && names.add(node.id.name),
    ImportSpecifier: (node) => names.add(node.local.name),
    ImportDefaultSpecifier: (node) => names.add(node.local.name),
    ImportNamespaceSpecifier: (node) => names.add(node.local.name),
    CatchClause: (node) => addBoundNames(node.param, names),
    TSEnumDeclaration: (node) => names.add(node.id.name),
    TSImportEqualsDeclaration: (node) => names.add(node.id.name),
  }).visit(program);
  return names;
};

const valueImports = (program: Program): ImportDeclaration[] =>
  program.body.filter(
    (statement): statement is ImportDeclaration =>
      statement.type === "ImportDeclaration" && statement.importKind !== "type",
  );

const requireDeclarations = (program: Program): RequireDeclaration[] =>
  program.body.flatMap((statement) => {
    if (statement.type !== "VariableDeclaration") return [];
    return statement.declarations.flatMap((declarator) => {
      const source = requiredModule(declarator.init);
      return source ? [{ statement, declarator, source }] : [];
    });
  });

/** How a file refers to `@hot-updater/server`'s `createHotUpdater`. */
const serverReferences = (program: Program) => {
  const functions = new Set<string>();
  const namespaces = new Set<string>();
  for (const declaration of valueImports(program)) {
    if (declaration.source.value !== SERVER_MODULE) continue;
    for (const specifier of declaration.specifiers) {
      if (specifier.type !== "ImportSpecifier") {
        namespaces.add(specifier.local.name);
      } else if (
        specifier.importKind !== "type" &&
        moduleExportName(specifier.imported) === "createHotUpdater"
      ) {
        functions.add(specifier.local.name);
      }
    }
  }
  new Visitor({
    VariableDeclarator: (node) => {
      if (requiredModule(node.init)?.value !== SERVER_MODULE) return;
      if (node.id.type === "Identifier") namespaces.add(node.id.name);
      const local = destructuredName(node.id, "createHotUpdater");
      if (local) functions.add(local);
    },
  }).visit(program);

  return (call: CallExpression): boolean => {
    const { callee } = call;
    if (callee.type === "Identifier") return functions.has(callee.name);
    if (
      callee.type !== "MemberExpression" ||
      callee.object.type !== "Identifier" ||
      !namespaces.has(callee.object.name)
    ) {
      return false;
    }
    const { property } = callee;
    return callee.computed
      ? isStringLiteral(property) && property.value === "createHotUpdater"
      : property.type === "Identifier" && property.name === "createHotUpdater";
  };
};

/** The expression each plugin factory is already imported as, if any. */
const importedPlugins = (program: Program): Map<PluginName, string> => {
  const references = new Map<PluginName, string>();
  const pluginOf = (module: string) =>
    PLUGIN_NAMES.find((name) => PLUGIN_MODULES[name] === module);
  for (const declaration of valueImports(program)) {
    const name = pluginOf(declaration.source.value);
    if (!name) continue;
    for (const specifier of declaration.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        references.set(name, `${specifier.local.name}.${name}`);
      } else if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type" &&
        moduleExportName(specifier.imported) === name
      ) {
        references.set(name, specifier.local.name);
      }
    }
  }
  for (const { declarator, source } of requireDeclarations(program)) {
    const name = pluginOf(source.value);
    if (!name) continue;
    const local =
      declarator.id.type === "Identifier"
        ? `${declarator.id.name}.${name}`
        : destructuredName(declarator.id, name);
    if (local) references.set(name, local);
  }
  return references;
};

/** Reads a `clientAccess` object from before 1.0, or the `"public"` after it. */
const readClientAccess = (
  source: string,
  property: ObjectPropertyKind,
): ClientAccessPolicy | Problem => {
  const notLiteral = problem(
    property.start,
    "clientAccess is not a literal, so it cannot be rewritten safely; migrate this call by hand.",
  );
  if (!isDataProperty(property)) return notLiteral;
  const value = unwrap(property.value);
  if (isStringLiteral(value)) {
    return value.value === "public"
      ? { type: "migrated" }
      : problem(
          value.start,
          `clientAccess: "${value.value}" is not a policy; use "public", or add apiKeys() to plugins.`,
        );
  }
  if (value.type !== "ObjectExpression") return notLiteral;

  let type: StringLiteral | undefined;
  let headerName: ObjectProperty | undefined;
  const unknownShape = problem(
    property.start,
    'clientAccess is not { type: "public" } or { type: "api-key", headerName }; migrate this call by hand.',
  );
  for (const option of value.properties) {
    if (option.type !== "Property" || option.kind !== "init" || option.method) {
      return unknownShape;
    }
    const name = propertyName(option);
    const optionValue = option.shorthand ? null : unwrap(option.value);
    if (name === "type" && optionValue && isStringLiteral(optionValue)) {
      type = optionValue;
    } else if (name === "headerName") {
      headerName = option;
    } else {
      return unknownShape;
    }
  }
  if (type?.value === "public" && headerName === undefined) {
    return {
      type: "public",
      value: property.value,
      quote: source[type.start] ?? '"',
    };
  }
  if (type?.value === "api-key") {
    return {
      type: "api-key",
      headerName: headerName && source.slice(headerName.start, headerName.end),
    };
  }
  return unknownShape;
};

/** The array literal a `plugins` property holds, when it has no spread or hole. */
const pluginList = (property: ObjectPropertyKind): ArrayExpression | null => {
  if (!isDataProperty(property)) return null;
  const value = unwrap(property.value);
  return value.type === "ArrayExpression" &&
    value.elements.every(
      (element) => element !== null && element.type !== "SpreadElement",
    )
    ? value
    : null;
};

/** The edits that move one `createHotUpdater` call to plugins. */
const rewriteCall = (
  source: string,
  call: CallExpression,
  reference: (name: PluginName) => string,
): CallRewrite | Problem => {
  const [argument, ...rest] = call.arguments;
  const options =
    argument && argument.type !== "SpreadElement" ? unwrap(argument) : null;
  if (options?.type !== "ObjectExpression" || rest.length > 0) {
    return problem(
      call.start,
      "createHotUpdater's options are not an object literal, so clientAccess cannot be checked; migrate this call by hand.",
    );
  }

  const properties = new Map<string, ObjectPropertyKind>();
  for (const property of options.properties) {
    if (property.type === "SpreadElement") {
      return problem(
        property.start,
        "createHotUpdater's options spread another object, which may set clientAccess or plugins; migrate this call by hand.",
      );
    }
    const name = propertyName(property);
    if (name === null) {
      return problem(
        property.start,
        "createHotUpdater's options use a computed key; migrate this call by hand.",
      );
    }
    properties.set(name, property);
  }

  const clientAccess = properties.get("clientAccess");
  const plugins = properties.get("plugins");
  if (!clientAccess) {
    return plugins
      ? { edits: [], plugins: [] }
      : problem(
          call.start,
          'createHotUpdater has neither clientAccess nor plugins; set clientAccess: "public", or add apiKeys() to plugins.',
        );
  }

  const policy = readClientAccess(source, clientAccess);
  if (isProblem(policy)) return policy;
  if (policy.type === "migrated") return { edits: [], plugins: [] };

  if (policy.type === "public") {
    const edits: TextEdit[] = [
      {
        start: policy.value.start,
        end: policy.value.end,
        text: `${policy.quote}public${policy.quote}`,
      },
    ];
    if (plugins) return { edits, plugins: [] };
    return {
      edits: [
        ...edits,
        ...insertListItemAfter(
          source,
          clientAccess,
          `plugins: [${reference("insights")}()]`,
        ),
      ],
      plugins: ["insights"],
    };
  }

  const apiKeysCall = `${reference("apiKeys")}(${
    policy.headerName === undefined ? "" : `{ ${policy.headerName} }`
  })`;
  if (!plugins) {
    return {
      edits: [
        {
          start: clientAccess.start,
          end: clientAccess.end,
          text: `plugins: [${reference("insights")}(), ${apiKeysCall}]`,
        },
      ],
      plugins: ["insights", "apiKeys"],
    };
  }
  const list = pluginList(plugins);
  if (!list) {
    return problem(
      plugins.start,
      "plugins is not an array literal, so apiKeys() cannot be added to it; add apiKeys() and remove clientAccess by hand.",
    );
  }
  const elements = list.elements as readonly Expression[];
  if (
    elements.some(
      (element) =>
        element.type === "CallExpression" &&
        source.slice(element.callee.start, element.callee.end) ===
          reference("apiKeys"),
    )
  ) {
    return problem(
      clientAccess.start,
      "plugins already has apiKeys(); remove clientAccess by hand.",
    );
  }
  const last: Span | undefined = elements.at(-1);
  return {
    edits: [
      ...removeListItem(source, options.properties, clientAccess),
      ...(last
        ? insertListItemAfter(source, last, apiKeysCall)
        : [{ start: list.start + 1, end: list.start + 1, text: apiKeysCall }]),
    ],
    plugins: ["apiKeys"],
  };
};

/** Edits that import plugin factories beside the file's other server imports. */
const importEdits = (
  source: string,
  program: Program,
  names: readonly PluginName[],
  offset: number,
): TextEdit[] | Problem => {
  const edits: TextEdit[] = [];
  const lines = new Map<number, string[]>();
  const addLine = (statement: Span, line: string) => {
    const end = lineEnd(source, statement.end);
    lines.set(end, [...(lines.get(end) ?? []), line]);
  };
  const imports = valueImports(program);
  const requires = requireDeclarations(program);
  for (const name of names) {
    const module = PLUGIN_MODULES[name];
    const joinsServerImports = (other: string) =>
      other.startsWith(SERVER_MODULE) && other < module;
    if (imports.length > 0) {
      const lastSpecifier = imports
        .find(
          (declaration) =>
            declaration.source.value === module &&
            declaration.specifiers.some(
              (specifier) => specifier.type === "ImportSpecifier",
            ),
        )
        ?.specifiers.at(-1);
      if (lastSpecifier) {
        edits.push(...insertListItemAfter(source, lastSpecifier, name));
        continue;
      }
      const anchor =
        findLast(imports, (declaration) =>
          joinsServerImports(declaration.source.value),
        ) ?? imports.at(-1)!;
      const quote = source[anchor.source.start];
      const semicolon = source[anchor.end - 1] === ";" ? ";" : "";
      addLine(
        anchor,
        `import { ${name} } from ${quote}${module}${quote}${semicolon}`,
      );
    } else {
      const anchor =
        findLast(requires, (declaration) =>
          joinsServerImports(declaration.source.value),
        ) ?? requires.at(-1);
      if (!anchor) {
        return problem(
          offset,
          `There is no import or require to add ${name} beside; import it from ${module} by hand.`,
        );
      }
      const { statement } = anchor;
      const quote = source[anchor.source.start];
      const semicolon = source[statement.end - 1] === ";" ? ";" : "";
      addLine(
        statement,
        `${statement.kind} { ${name} } = require(${quote}${module}${quote})${semicolon}`,
      );
    }
  }
  const lineBreak = lineBreakOf(source);
  for (const [end, added] of lines) {
    edits.push({
      start: end,
      end,
      text: added.map((line) => `${lineBreak}${line}`).join(""),
    });
  }
  return edits;
};

/**
 * Moves `createHotUpdater` calls from the `clientAccess` objects of the 1.0
 * release candidates to plugins: `{ type: "public" }` becomes `"public"`,
 * `{ type: "api-key", headerName }` becomes `apiKeys({ headerName })` in
 * `plugins`, and a call without `plugins` gets `insights()`, which ran by
 * default before. A file with a call it cannot rewrite safely is reported and
 * left unchanged.
 */
export const transformClientAccess = (
  source: string,
  filename: string,
): CodemodResult => {
  const unchanged = (problems: readonly Problem[] = []): CodemodResult => ({
    text: source,
    issues: problems.map(({ offset, message }) => ({
      ...locate(source, offset),
      message,
    })),
  });

  let program: Program;
  try {
    const parsed = parseSync(filename, source, {
      preserveParens: false,
      sourceType: filename.endsWith(".cjs") ? "commonjs" : "module",
    });
    const [parseError] = parsed.errors;
    if (parseError) {
      return unchanged([
        problem(
          parseError.labels[0]?.start ?? 0,
          `Could not parse this file: ${parseError.message}`,
        ),
      ]);
    }
    program = parsed.program;
  } catch (error) {
    return unchanged([
      problem(
        0,
        `Could not parse this file: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ]);
  }
  const callsCreateHotUpdater = serverReferences(program);
  const calls: CallExpression[] = [];
  new Visitor({
    CallExpression: (node) => {
      if (callsCreateHotUpdater(node)) calls.push(node);
    },
  }).visit(program);
  if (calls.length === 0) return unchanged();

  const imported = importedPlugins(program);
  const declared = declaredNames(program);
  const reference = (name: PluginName) => imported.get(name) ?? name;
  const problems: Problem[] = [];
  const edits: TextEdit[] = [];
  const toImport = new Set<PluginName>();
  for (const call of calls) {
    const rewrite = rewriteCall(source, call, reference);
    if (isProblem(rewrite)) {
      problems.push(rewrite);
      continue;
    }
    edits.push(...rewrite.edits);
    for (const name of rewrite.plugins) {
      if (imported.has(name) || toImport.has(name)) continue;
      if (declared.has(name)) {
        problems.push(
          problem(
            call.start,
            `${name} is already declared in this file; add ${name}() from ${PLUGIN_MODULES[name]} by hand.`,
          ),
        );
      }
      toImport.add(name);
    }
  }
  if (problems.length > 0) return unchanged(problems);

  const imports = importEdits(
    source,
    program,
    PLUGIN_NAMES.filter((name) => toImport.has(name)),
    calls[0]!.start,
  );
  if (isProblem(imports)) return unchanged([imports]);
  try {
    return { text: applyTextEdits(source, [...edits, ...imports]), issues: [] };
  } catch {
    return unchanged([
      problem(
        calls[0]!.start,
        "createHotUpdater calls overlap, so they cannot be rewritten safely; migrate them by hand.",
      ),
    ]);
  }
};

/** `hot-updater codemod client-access`. */
export const clientAccessCodemod: Codemod = {
  name: "client-access",
  marker: "createHotUpdater",
  transform: transformClientAccess,
};
