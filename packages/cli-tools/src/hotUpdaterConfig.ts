import fs from "fs/promises";
import path from "path";

import {
  parseSync,
  type CallExpression,
  type ExportDefaultDeclaration,
  type Expression,
  type ObjectExpression,
  type ObjectProperty,
  type ObjectPropertyKind,
  type Program,
  type Span,
  type VariableDeclaration,
  type VariableDeclarator,
} from "oxc-parser";

import {
  type BuildType,
  ConfigBuilder,
  type ImportInfo,
  type ProviderConfig,
  renderImportStatements,
} from "./ConfigBuilder";
import { p } from "./prompts";

export type ManagedHelperStrategy =
  | "merge-object"
  | "preserve-existing"
  | "replace";

export type ManagedHelperStatement = {
  name: string;
  code: string;
  strategy: ManagedHelperStrategy;
  replaceIncompatibleProperties?: string[];
};

export type CreateHotUpdaterConfigScaffoldOptions = {
  build: BuildType;
  storage: ProviderConfig;
  database: ProviderConfig;
  plugins: ProviderConfig;
  extraImports?: ImportInfo[];
  helperStatements?: ManagedHelperStatement[];
  updateStrategy?: "appVersion" | "fingerprint";
};

export type CreateHotUpdaterConfigScaffoldFromBuilderOptions = {
  helperStatements?: ManagedHelperStatement[];
  updateStrategy?: "appVersion" | "fingerprint";
};

export type HotUpdaterConfigScaffold = {
  text: string;
  imports: ImportInfo[];
  build: {
    initializer: string;
    callee: string;
  };
  storage: {
    initializer: string;
    callee: string;
  };
  database: {
    initializer: string;
    callee: string;
  };
  /** The plugins the server runs, such as a provider package's `plugins`. */
  plugins: {
    initializer: string;
  };
  helperStatements: ManagedHelperStatement[];
  updateStrategy: string;
};

export type WriteHotUpdaterConfigResult = {
  status: "created" | "merged" | "skipped";
  path: string;
  reason?: string;
};

const HOT_UPDATER_CONFIG_PATH = "hot-updater.config.ts";
const CONFIG_FILE_NAME = "hot-updater.config.ts";
const MANAGED_IMPORT_PACKAGES = new Set([
  "firebase-admin",
  "firebase-admin/app",
  "hot-updater",
  "@aws-sdk/credential-provider-sso",
  "@aws-sdk/credential-providers",
  "@hot-updater/aws",
  "@hot-updater/bare",
  "@hot-updater/cloudflare",
  "@hot-updater/expo",
  "@hot-updater/firebase",
  "@hot-updater/rock",
  "@hot-updater/supabase",
]);
const MANAGED_HELPER_NAMES = new Set([
  "awsOptions",
  "commonOptions",
  "credential",
  "storageOptions",
]);
const KNOWN_BUILD_CALLEES = new Set(["bare", "expo", "rock"]);
/** Build adapter packages, whose imports a kept build still needs. */
const BUILD_IMPORT_PACKAGES = new Set(
  [...KNOWN_BUILD_CALLEES].map((callee) => `@hot-updater/${callee}`),
);

type ConfigSource = {
  readonly program: Program;
  readonly text: string;
};

type ImportDeclarationNode = Extract<
  Program["body"][number],
  { type: "ImportDeclaration" }
>;

const importDeclarationsOf = (source: ConfigSource) =>
  source.program.body.filter(
    (statement): statement is ImportDeclarationNode =>
      statement.type === "ImportDeclaration",
  );

type TopLevelStatement = Program["body"][number];

type ConfigObject = {
  readonly exportDeclaration: ExportDefaultDeclaration;
  readonly objectExpression: ObjectExpression;
};

type ParsedVariableStatement = {
  readonly source: ConfigSource;
  readonly statement: VariableDeclaration;
  readonly declaration: VariableDeclarator;
};

type CallSource = {
  readonly callExpression: CallExpression;
  readonly source: ConfigSource;
};

type ObjectSource = {
  readonly objectExpression: ObjectExpression;
  readonly source: ConfigSource;
};

type ManagedConfigObject = {
  readonly objectExpression: ObjectExpression;
  readonly source: ConfigSource;
};

type TextEdit = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

type ConfigTextMergeResult =
  | { readonly text: string }
  | { readonly reason: string };

const parseConfigSource = (text: string): ConfigSource | null => {
  const result = parseSync(CONFIG_FILE_NAME, text, {
    astType: "js",
    lang: "ts",
    preserveParens: false,
    sourceType: "module",
    showSemanticErrors: false,
  });

  if (result.errors.length > 0) {
    return null;
  }

  return {
    program: result.program,
    text,
  };
};

const getNodeText = (source: ConfigSource, node: Span) =>
  source.text.slice(node.start, node.end);

const getTopLevelFullStart = (
  source: ConfigSource,
  statement: TopLevelStatement,
) => {
  const statementIndex = source.program.body.findIndex(
    (candidate) => candidate === statement,
  );
  if (statementIndex <= 0) {
    return statementIndex === 0 ? 0 : statement.start;
  }

  return source.program.body[statementIndex - 1]?.end ?? statement.start;
};

const getStatementText = (source: ConfigSource, statement: TopLevelStatement) =>
  source.text
    .slice(getTopLevelFullStart(source, statement), statement.end)
    .trim();

const parseVariableStatement = (
  text: string,
): ParsedVariableStatement | null => {
  const source = parseConfigSource(text);
  if (!source) {
    return null;
  }

  const statement = source.program.body.find(
    (candidate) => candidate.type === "VariableDeclaration",
  );
  if (statement?.type !== "VariableDeclaration") {
    return null;
  }

  const declaration = statement.declarations[0];
  if (declaration?.id.type !== "Identifier" || !declaration.init) {
    return null;
  }

  return {
    source,
    statement,
    declaration,
  };
};

const getConfigObjectExpression = (
  argument: CallExpression["arguments"][number] | undefined,
) => {
  const expression =
    argument?.type === "TSSatisfiesExpression" ? argument.expression : argument;
  return expression?.type === "ObjectExpression" ? expression : null;
};

const findDefineConfigObject = (source: ConfigSource): ConfigObject | null => {
  const exportDeclaration = source.program.body.find((statement) => {
    if (statement.type !== "ExportDefaultDeclaration") {
      return false;
    }

    const declaration = statement.declaration;
    if (
      declaration.type !== "CallExpression" ||
      declaration.callee.type !== "Identifier"
    ) {
      return false;
    }

    return (
      declaration.callee.name === "defineConfig" &&
      getConfigObjectExpression(declaration.arguments[0]) !== null
    );
  });

  if (exportDeclaration?.type !== "ExportDefaultDeclaration") {
    return null;
  }

  const declaration = exportDeclaration.declaration;
  if (declaration.type !== "CallExpression") {
    return null;
  }

  const objectExpression = getConfigObjectExpression(declaration.arguments[0]);
  if (!objectExpression) {
    return null;
  }

  return {
    exportDeclaration,
    objectExpression,
  };
};

const getObjectPropertyName = (property: ObjectPropertyKind): string | null => {
  if (property.type === "SpreadElement" || property.computed) {
    return null;
  }

  const { key } = property;
  if (key.type === "Identifier") {
    return key.name;
  }

  if (
    key.type === "Literal" &&
    (typeof key.value === "string" || typeof key.value === "number")
  ) {
    return String(key.value);
  }

  return null;
};

const isDataProperty = (
  property: ObjectPropertyKind,
): property is ObjectProperty =>
  property.type === "Property" &&
  property.kind === "init" &&
  !property.method &&
  !property.shorthand;

const dedentBlock = (text: string) => {
  const lines = text.replace(/\s+$/, "").split("\n");
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;

  return lines.map((line) => line.slice(minIndent)).join("\n");
};

const indentBlock = (text: string, indent: string) =>
  dedentBlock(text)
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");

const lineStartOf = (text: string, position: number) =>
  text.lastIndexOf("\n", position - 1) + 1;

/** The indentation of the line `position` is on. */
const lineIndentAt = (text: string, position: number) =>
  /^[ \t]*/.exec(text.slice(lineStartOf(text, position)))?.[0] ?? "";

/** Whether `node` is the first thing on its line. */
const startsLine = (text: string, node: Span) =>
  /^[ \t]*$/.test(text.slice(lineStartOf(text, node.start), node.start));

/**
 * A property's text with the indentation of its line, so that a property
 * spanning lines dedents and indents as one block.
 */
const getPropertyBlockText = (source: ConfigSource, property: Span) =>
  source.text.slice(
    startsLine(source.text, property)
      ? lineStartOf(source.text, property.start)
      : property.start,
    property.end,
  );

/**
 * The edits, relative to `object`'s start, that add `propertyTexts` after its
 * last property: each on a line of its own, after that property's comma and
 * whatever comment shares its line, or after it on the line of a one-line
 * object.
 */
const appendPropertiesEdits = (
  source: ConfigSource,
  object: ObjectExpression,
  propertyTexts: readonly string[],
): TextEdit[] => {
  if (propertyTexts.length === 0) {
    return [];
  }

  const { text } = source;
  const closeBrace = object.end - 1;
  const relative = (position: number) => position - object.start;
  const closingIndent = lineIndentAt(text, closeBrace);
  const last = object.properties.at(-1);
  if (!last) {
    const childIndent = `${closingIndent}  `;
    return [
      {
        start: relative(object.start + 1),
        end: relative(closeBrace),
        text: `\n${propertyTexts
          .map((propertyText) => indentBlock(propertyText, childIndent))
          .join(",\n")},\n${closingIndent}`,
      },
    ];
  }

  const comma = /^\s*,/.exec(text.slice(last.end, closeBrace));
  const afterLast = last.end + (comma?.[0].length ?? 0);
  const lineEnd = text.indexOf("\n", afterLast);
  if (!startsLine(text, last) || lineEnd === -1 || lineEnd > closeBrace) {
    return [
      {
        start: relative(afterLast),
        end: relative(afterLast),
        text: `${comma ? " " : ", "}${propertyTexts
          .map((propertyText) => dedentBlock(propertyText))
          .join(", ")}`,
      },
    ];
  }

  const childIndent = lineIndentAt(text, last.start);
  return [
    ...(comma
      ? []
      : [{ start: relative(last.end), end: relative(last.end), text: "," }]),
    {
      start: relative(lineEnd),
      end: relative(lineEnd),
      text: `\n${propertyTexts
        .map((propertyText) => indentBlock(propertyText, childIndent))
        .join(",\n")},`,
    },
  ];
};

const mergeObjectLiteralText = (
  existingObject: ObjectSource,
  newObject: ObjectSource,
  replaceIncompatibleProperties: readonly string[] = [],
): string | null => {
  const existingText = getNodeText(
    existingObject.source,
    existingObject.objectExpression,
  );
  const existingPropertyNames = new Set<string>();
  const existingSpreadTexts = new Set<string>();
  const edits: TextEdit[] = [];

  for (const property of existingObject.objectExpression.properties) {
    if (property.type === "SpreadElement") {
      existingSpreadTexts.add(
        getNodeText(existingObject.source, property.argument).trim(),
      );
      continue;
    }

    const propertyName = getObjectPropertyName(property);
    if (!propertyName) {
      continue;
    }

    existingPropertyNames.add(propertyName);
    const nextProperty = newObject.objectExpression.properties.find(
      (candidate) => getObjectPropertyName(candidate) === propertyName,
    );
    if (
      !nextProperty ||
      !isDataProperty(property) ||
      !isDataProperty(nextProperty)
    ) {
      continue;
    }

    const existingCallee = getCallCallee(property.value);
    const nextCallee = getCallCallee(nextProperty.value);
    const hasIncompatibleValue =
      (existingCallee !== null &&
        nextCallee !== null &&
        existingCallee !== nextCallee) ||
      (property.value.type === "ObjectExpression") !==
        (nextProperty.value.type === "ObjectExpression");
    if (
      replaceIncompatibleProperties.includes(propertyName) &&
      hasIncompatibleValue
    ) {
      edits.push({
        start: property.value.start - existingObject.objectExpression.start,
        end: property.value.end - existingObject.objectExpression.start,
        text: getNodeText(newObject.source, nextProperty.value),
      });
      continue;
    }

    if (
      property.value.type === "ObjectExpression" &&
      nextProperty.value.type === "ObjectExpression"
    ) {
      const mergedValue = mergeObjectLiteralText(
        {
          objectExpression: property.value,
          source: existingObject.source,
        },
        {
          objectExpression: nextProperty.value,
          source: newObject.source,
        },
        replaceIncompatibleProperties,
      );
      if (!mergedValue) {
        return null;
      }

      edits.push({
        start: property.value.start - existingObject.objectExpression.start,
        end: property.value.end - existingObject.objectExpression.start,
        text: mergedValue,
      });
    }
  }

  const missingPropertyTexts = newObject.objectExpression.properties
    .filter((property) => {
      if (property.type === "SpreadElement") {
        return !existingSpreadTexts.has(
          getNodeText(newObject.source, property.argument).trim(),
        );
      }

      const propertyName = getObjectPropertyName(property);
      return propertyName ? !existingPropertyNames.has(propertyName) : false;
    })
    .map((property) => getPropertyBlockText(newObject.source, property));

  return applyTextEdits(existingText, [
    ...edits,
    ...appendPropertiesEdits(
      existingObject.source,
      existingObject.objectExpression,
      missingPropertyTexts,
    ),
  ]);
};

const buildMergedCallInitializer = (existing: CallSource, next: CallSource) => {
  const [existingArgument] = existing.callExpression.arguments;
  const [nextArgument] = next.callExpression.arguments;

  if (
    existing.callExpression.arguments.length === 1 &&
    next.callExpression.arguments.length === 1 &&
    existingArgument?.type === "ObjectExpression" &&
    nextArgument?.type === "ObjectExpression"
  ) {
    const mergedObjectLiteral = mergeObjectLiteralText(
      {
        objectExpression: existingArgument,
        source: existing.source,
      },
      {
        objectExpression: nextArgument,
        source: next.source,
      },
    );
    if (!mergedObjectLiteral) {
      return null;
    }

    return `${getNodeText(
      existing.source,
      existing.callExpression.callee,
    )}(${mergedObjectLiteral})`;
  }

  return getNodeText(existing.source, existing.callExpression);
};

const findManagedProperty = (
  objectExpression: ObjectExpression,
  propertyName: string,
): ObjectProperty | null => {
  const property = objectExpression.properties.find(
    (candidate) =>
      candidate.type === "Property" &&
      candidate.kind === "init" &&
      !candidate.method &&
      !candidate.shorthand &&
      getObjectPropertyName(candidate) === propertyName,
  );

  return property?.type === "Property" ? property : null;
};

/** The `plugins` property, written either way: `plugins: [...]` or `plugins`. */
const findPluginsProperty = (
  objectExpression: ObjectExpression,
): ObjectProperty | null => {
  const property = objectExpression.properties.find(
    (candidate) =>
      candidate.type === "Property" &&
      candidate.kind === "init" &&
      !candidate.method &&
      getObjectPropertyName(candidate) === "plugins",
  );

  return property?.type === "Property" ? property : null;
};

const getCallCallee = (expression: Expression) => {
  if (
    expression.type !== "CallExpression" ||
    expression.callee.type !== "Identifier"
  ) {
    return null;
  }

  return expression.callee.name;
};

const mergeHelperStatement = (
  existingStatementText: string,
  helper: ManagedHelperStatement,
) => {
  if (helper.strategy === "preserve-existing") {
    return existingStatementText;
  }

  if (helper.strategy === "replace") {
    return helper.code.trim();
  }

  const existingStatement = parseVariableStatement(existingStatementText);
  const nextStatement = parseVariableStatement(helper.code);
  if (!existingStatement || !nextStatement) {
    return null;
  }

  const existingInitializer = existingStatement.declaration.init;
  const nextInitializer = nextStatement.declaration.init;
  if (
    existingInitializer?.type !== "ObjectExpression" ||
    nextInitializer?.type !== "ObjectExpression"
  ) {
    return null;
  }

  const mergedInitializer = mergeObjectLiteralText(
    {
      objectExpression: existingInitializer,
      source: existingStatement.source,
    },
    {
      objectExpression: nextInitializer,
      source: nextStatement.source,
    },
    helper.replaceIncompatibleProperties,
  );
  if (!mergedInitializer) {
    return null;
  }

  const declarationKind =
    existingStatement.statement.kind === "let" ||
    existingStatement.statement.kind === "var"
      ? existingStatement.statement.kind
      : "const";

  return `${declarationKind} ${helper.name} = ${mergedInitializer};`;
};

/**
 * The config object with the scaffold's `build`, `storage`, `database`, and
 * `plugins`: a call to the same adapter keeps the project's arguments and
 * gains the scaffold's missing ones, and `plugins` is the scaffold's. A build
 * that is not a plain build adapter, such as `withSentry(bare())`, stays the
 * project's (`keptBuild`). Null when `build`, `storage`, or `database` is no
 * call.
 */
const updateManagedObject = (
  existing: ManagedConfigObject,
  next: ManagedConfigObject,
): { readonly text: string; readonly keptBuild: boolean } | null => {
  const objectStart = existing.objectExpression.start;
  const objectText = getNodeText(existing.source, existing.objectExpression);
  const propertyEdits: TextEdit[] = [];
  const missingPropertyTexts: string[] = [];
  let keptBuild = false;

  for (const propertyName of ["build", "storage", "database"]) {
    const existingProperty = findManagedProperty(
      existing.objectExpression,
      propertyName,
    );
    const nextProperty = findManagedProperty(
      next.objectExpression,
      propertyName,
    );
    if (!nextProperty) {
      continue;
    }

    if (!existingProperty) {
      missingPropertyTexts.push(
        getPropertyBlockText(next.source, nextProperty),
      );
      continue;
    }

    const existingCallee = getCallCallee(existingProperty.value);
    const nextCallee = getCallCallee(nextProperty.value);
    if (!existingCallee || !nextCallee) {
      return null;
    }

    let nextInitializerText = getNodeText(next.source, nextProperty.value);
    if (propertyName === "build") {
      if (!KNOWN_BUILD_CALLEES.has(existingCallee)) {
        keptBuild = true;
        continue;
      }

      if (existingCallee === nextCallee) {
        continue;
      }
    } else if (existingCallee === nextCallee) {
      if (
        existingProperty.value.type !== "CallExpression" ||
        nextProperty.value.type !== "CallExpression"
      ) {
        return null;
      }

      const mergedInitializer = buildMergedCallInitializer(
        {
          callExpression: existingProperty.value,
          source: existing.source,
        },
        {
          callExpression: nextProperty.value,
          source: next.source,
        },
      );
      if (!mergedInitializer) {
        return null;
      }

      nextInitializerText = mergedInitializer;
    }

    propertyEdits.push({
      start: existingProperty.value.start - objectStart,
      end: existingProperty.value.end - objectStart,
      text: nextInitializerText,
    });
  }

  // The config lists the plugins the server runs, which the scaffold names.
  const existingPlugins = findPluginsProperty(existing.objectExpression);
  const nextPlugins = findPluginsProperty(next.objectExpression);
  if (nextPlugins) {
    const nextPluginsText = getNodeText(next.source, nextPlugins);
    if (!existingPlugins) {
      missingPropertyTexts.push(getPropertyBlockText(next.source, nextPlugins));
    } else if (
      getNodeText(existing.source, existingPlugins).replace(/\s+/gu, "") !==
      nextPluginsText.replace(/\s+/gu, "")
    ) {
      propertyEdits.push({
        start: existingPlugins.start - objectStart,
        end: existingPlugins.end - objectStart,
        text: nextPluginsText,
      });
    }
  }

  return {
    text: applyTextEdits(objectText, [
      ...propertyEdits,
      ...appendPropertiesEdits(
        existing.source,
        existing.objectExpression,
        missingPropertyTexts,
      ),
    ]),
    keptBuild,
  };
};

const getManagedHelperName = (statement: TopLevelStatement) => {
  if (statement.type !== "VariableDeclaration") {
    return null;
  }

  const declaration = statement.declarations[0];
  if (declaration?.id.type !== "Identifier") {
    return null;
  }

  return declaration.id.name;
};

/** Whether `text` refers to `name` as an identifier. */
const usesIdentifier = (text: string, name: string) =>
  new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(text);

/**
 * What a managed package's existing imports bring that the rebuilt config
 * still uses and the scaffold doesn't import, such as a project's own `cert`
 * from firebase-admin/app beside the `credential` helper init keeps. Named
 * value imports join the scaffold's import of that package; default,
 * namespace, and type imports keep a declaration of their own.
 */
const keptManagedImports = (
  declarations: readonly ImportDeclarationNode[],
  scaffoldImports: readonly ImportInfo[],
  usedText: string,
): { readonly imports: ImportInfo[]; readonly texts: string[] } => {
  const bound = new Set(
    scaffoldImports.flatMap((info) => [
      ...(info.named ?? []).map((name) => name.split(/\s+as\s+/).at(-1)!),
      ...(info.defaultOrNamespace === undefined
        ? []
        : [info.defaultOrNamespace.replace(/^\*\s+as\s+/, "")]),
    ]),
  );
  const imports: ImportInfo[] = [];
  const texts: string[] = [];
  for (const declaration of declarations) {
    const pkg = declaration.source.value;
    const named: string[] = [];
    let defaultName: string | undefined;
    let namespaceName: string | undefined;
    for (const specifier of declaration.specifiers) {
      const local = specifier.local.name;
      if (bound.has(local) || !usesIdentifier(usedText, local)) continue;
      if (specifier.type === "ImportDefaultSpecifier") {
        defaultName = local;
      } else if (specifier.type === "ImportNamespaceSpecifier") {
        namespaceName = local;
      } else {
        const imported =
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : JSON.stringify(specifier.imported.value);
        const name = imported === local ? local : `${imported} as ${local}`;
        named.push(specifier.importKind === "type" ? `type ${name}` : name);
      }
    }
    if (named.length === 0 && !defaultName && !namespaceName) continue;
    if (declaration.importKind === "type") {
      texts.push(`import type { ${named.join(", ")} } from "${pkg}";`);
      continue;
    }
    if (named.length > 0) imports.push({ pkg, named });
    if (namespaceName)
      texts.push(`import * as ${namespaceName} from "${pkg}";`);
    if (defaultName) texts.push(`import ${defaultName} from "${pkg}";`);
  }
  return { imports, texts };
};

const rebuildImportBlock = (
  source: ConfigSource,
  scaffold: HotUpdaterConfigScaffold,
  {
    keptBuild,
    usedText,
  }: {
    readonly keptBuild: boolean;
    /** The rebuilt config without its imports: what decides which imports stay. */
    readonly usedText: string;
  },
): TextEdit => {
  // Keep environment-loading imports under the existing config's control,
  // and a kept build's adapter import with it.
  const imports = scaffold.imports
    .filter((info) => !(keptBuild && BUILD_IMPORT_PACKAGES.has(info.pkg)))
    .map((info) =>
      info.pkg === "node:fs"
        ? {
            ...info,
            named: info.named?.filter((name) => name !== "existsSync"),
          }
        : info,
    );
  const importDeclarations = importDeclarationsOf(source);
  const firstImport = importDeclarations[0];
  const lastImport = importDeclarations.at(-1);
  if (!firstImport || !lastImport) {
    return {
      start: 0,
      end: 0,
      text: `${renderImportStatements(imports)}\n\n`,
    };
  }

  const isPreserved = (declaration: ImportDeclarationNode) =>
    !MANAGED_IMPORT_PACKAGES.has(declaration.source.value) ||
    (keptBuild && BUILD_IMPORT_PACKAGES.has(declaration.source.value));
  const preservedImportTexts = importDeclarations
    .filter(isPreserved)
    .map((declaration) =>
      source.text
        .slice(getTopLevelFullStart(source, declaration), declaration.end)
        .trim(),
    );
  const kept = keptManagedImports(
    importDeclarations.filter((declaration) => !isPreserved(declaration)),
    imports,
    usedText,
  );
  const managedImportText = renderImportStatements([
    ...imports,
    ...kept.imports,
  ]);
  const nextImportBlock = [
    ...preservedImportTexts,
    ...kept.texts,
    managedImportText,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    start: getTopLevelFullStart(source, firstImport),
    end: lastImport.end,
    text: nextImportBlock,
  };
};

const rebuildManagedBody = (
  source: ConfigSource,
  exportStart: number,
  scaffold: HotUpdaterConfigScaffold,
): TextEdit | null => {
  const statementsBeforeExport = source.program.body.filter(
    (statement) =>
      statement.type !== "ImportDeclaration" && statement.start < exportStart,
  );
  const managedHelpers = new Map(
    scaffold.helperStatements.map((statement) => [statement.name, statement]),
  );
  const emittedHelpers = new Set<string>();
  const bodyStatements: string[] = [];

  for (const statement of statementsBeforeExport) {
    const helperName = getManagedHelperName(statement);
    if (!helperName || !MANAGED_HELPER_NAMES.has(helperName)) {
      bodyStatements.push(getStatementText(source, statement));
      continue;
    }

    const helper = managedHelpers.get(helperName);
    if (!helper) {
      // Remove helper declarations managed by the previous provider.
      continue;
    }

    const mergedHelper = mergeHelperStatement(
      getStatementText(source, statement),
      helper,
    );
    if (!mergedHelper) {
      return null;
    }

    emittedHelpers.add(helperName);
    bodyStatements.push(mergedHelper);
  }

  for (const helper of scaffold.helperStatements) {
    if (!emittedHelpers.has(helper.name)) {
      bodyStatements.push(helper.code.trim());
    }
  }

  const bodyText = bodyStatements.filter(Boolean).join("\n\n");
  const managedBody = bodyText ? `\n\n${bodyText}\n\n` : "\n\n";
  const lastImport = source.program.body
    .filter((statement) => statement.type === "ImportDeclaration")
    .at(-1);

  return {
    start: lastImport?.end ?? 0,
    end: exportStart,
    text: managedBody,
  };
};

const applyTextEdits = (sourceText: string, edits: readonly TextEdit[]) => {
  let mergedText = sourceText;
  for (const edit of [...edits].sort(
    (left, right) => right.start - left.start,
  )) {
    mergedText =
      mergedText.slice(0, edit.start) + edit.text + mergedText.slice(edit.end);
  }
  return mergedText;
};

const mergeHotUpdaterConfigText = (
  existingText: string,
  scaffold: HotUpdaterConfigScaffold,
): ConfigTextMergeResult => {
  const existingSource = parseConfigSource(existingText);
  const nextSource = parseConfigSource(scaffold.text);
  if (!existingSource || !nextSource) {
    return {
      reason:
        "Existing config is not a supported `export default defineConfig({ ... })` shape.",
    };
  }

  const existingConfig = findDefineConfigObject(existingSource);
  const nextConfig = findDefineConfigObject(nextSource);
  if (!existingConfig || !nextConfig) {
    return {
      reason:
        "Existing config is not a supported `export default defineConfig({ ... })` shape.",
    };
  }

  const nextObject = updateManagedObject(
    {
      objectExpression: existingConfig.objectExpression,
      source: existingSource,
    },
    {
      objectExpression: nextConfig.objectExpression,
      source: nextSource,
    },
  );
  if (!nextObject) {
    return {
      reason:
        "Existing config uses dynamic build/storage/database expressions that cannot be merged safely.",
    };
  }

  const exportFullStart = getTopLevelFullStart(
    existingSource,
    existingConfig.exportDeclaration,
  );
  const exportLeadingTrivia = existingText.slice(
    exportFullStart,
    existingConfig.exportDeclaration.start,
  );
  const firstTriviaContent = exportLeadingTrivia.search(/\S/);
  const managedBodyEnd =
    firstTriviaContent === -1
      ? existingConfig.exportDeclaration.start
      : exportFullStart + firstTriviaContent;
  const bodyEdit = rebuildManagedBody(existingSource, managedBodyEnd, scaffold);
  if (!bodyEdit) {
    return {
      reason: "Existing helper declarations could not be merged safely.",
    };
  }

  // A name the project imports from elsewhere, such as its own `plugins`
  // list, can't also take the scaffold's import of that name.
  const scaffoldNames = new Map(
    scaffold.imports.flatMap((info) =>
      (info.named ?? []).map(
        (name) => [name.split(/\s+as\s+/).at(-1)!, info.pkg] as const,
      ),
    ),
  );
  for (const declaration of importDeclarationsOf(existingSource)) {
    const pkg = declaration.source.value;
    if (
      MANAGED_IMPORT_PACKAGES.has(pkg) &&
      !(nextObject.keptBuild && BUILD_IMPORT_PACKAGES.has(pkg))
    ) {
      continue;
    }
    for (const specifier of declaration.specifiers) {
      const scaffoldPackage = scaffoldNames.get(specifier.local.name);
      if (scaffoldPackage !== undefined && scaffoldPackage !== pkg) {
        return {
          reason: `The import of ${specifier.local.name} from "${pkg}" takes the name init imports from "${scaffoldPackage}".`,
        };
      }
    }
  }

  const objectEdit: TextEdit = {
    start: existingConfig.objectExpression.start,
    end: existingConfig.objectExpression.end,
    text: nextObject.text,
  };
  // The rebuilt config with its imports blanked out, which decides the
  // imports a managed package keeps beyond the scaffold's.
  const usedText = applyTextEdits(existingText, [
    objectEdit,
    bodyEdit,
    ...importDeclarationsOf(existingSource).map((declaration) => ({
      start: declaration.start,
      end: declaration.end,
      text: "",
    })),
  ]);

  return {
    text: applyTextEdits(existingText, [
      objectEdit,
      bodyEdit,
      rebuildImportBlock(existingSource, scaffold, {
        keptBuild: nextObject.keptBuild,
        usedText,
      }),
    ]),
  };
};

const extractCallIdentifier = (initializer: string) => {
  const match = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(initializer);
  if (!match) {
    throw new Error(`Failed to extract call identifier from "${initializer}"`);
  }

  return match[1];
};

export const createHotUpdaterConfigScaffold = ({
  build,
  storage,
  database,
  plugins,
  extraImports = [],
  helperStatements = [],
  updateStrategy = "appVersion",
}: CreateHotUpdaterConfigScaffoldOptions): HotUpdaterConfigScaffold => {
  const intermediateCode = helperStatements
    .map((statement) => statement.code.trim())
    .filter(Boolean)
    .join("\n\n");

  const builder = new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storage)
    .setDatabase(database)
    .setPlugins(plugins);

  for (const extraImport of extraImports) {
    builder.addImport(extraImport);
  }

  if (intermediateCode) {
    builder.setIntermediateCode(intermediateCode);
  }

  return createHotUpdaterConfigScaffoldFromBuilder(builder, {
    helperStatements,
    updateStrategy,
  });
};

export const createHotUpdaterConfigScaffoldFromBuilder = (
  builder: ConfigBuilder,
  {
    helperStatements = [],
    updateStrategy = "appVersion",
  }: CreateHotUpdaterConfigScaffoldFromBuilderOptions = {},
): HotUpdaterConfigScaffold => {
  const scaffold = builder.getScaffold();
  const strategyText =
    updateStrategy === "appVersion"
      ? scaffold.text
      : scaffold.text.replace(
          'updateStrategy: "appVersion"',
          `updateStrategy: "${updateStrategy}"`,
        );
  return {
    text: strategyText,
    imports: scaffold.imports,
    build: {
      initializer: scaffold.buildConfigString,
      callee: extractCallIdentifier(scaffold.buildConfigString),
    },
    storage: {
      initializer: scaffold.storageConfigString,
      callee: extractCallIdentifier(scaffold.storageConfigString),
    },
    database: {
      initializer: scaffold.databaseConfigString,
      callee: extractCallIdentifier(scaffold.databaseConfigString),
    },
    plugins: {
      initializer: scaffold.pluginsConfigString,
    },
    helperStatements,
    updateStrategy: `"${updateStrategy}"`,
  };
};

const readTextFile = (filePath: string) =>
  fs.readFile(filePath, "utf-8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  });

/**
 * Writes hot-updater.config.ts: the scaffold's when there is none, or the
 * existing config with the scaffold's build, storage, database, plugins, and
 * helpers merged in, keeping the project's own settings.
 */
export const writeHotUpdaterConfig = async (
  scaffold: HotUpdaterConfigScaffold,
  filePath = HOT_UPDATER_CONFIG_PATH,
): Promise<WriteHotUpdaterConfigResult> => {
  const existingText = await readTextFile(filePath);

  if (existingText === null) {
    await fs.writeFile(filePath, `${scaffold.text}\n`, "utf-8");
    return {
      status: "created",
      path: filePath,
    };
  }

  const mergeResult = mergeHotUpdaterConfigText(existingText, scaffold);
  if ("reason" in mergeResult) {
    return {
      status: "skipped",
      path: filePath,
      reason: mergeResult.reason,
    };
  }

  await fs.writeFile(filePath, mergeResult.text, "utf-8");
  return {
    status: "merged",
    path: filePath,
  };
};

/**
 * What a config needs for the scaffold's storage, database, and plugins:
 * their imports, the helpers they read, and the properties themselves.
 */
const renderServerSettings = (scaffold: HotUpdaterConfigScaffold) => {
  const imports = scaffold.imports.filter(
    ({ pkg }) =>
      pkg !== "hot-updater" &&
      pkg !== "node:fs" &&
      !BUILD_IMPORT_PACKAGES.has(pkg),
  );
  const plugins = scaffold.plugins.initializer;
  return [
    renderImportStatements(imports),
    ...scaffold.helperStatements.map(({ code }) => code.trim()),
    [
      `  storage: ${scaffold.storage.initializer},`,
      `  database: ${scaffold.database.initializer},`,
      `  ${plugins === "plugins" ? "plugins" : `plugins: ${plugins}`},`,
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
};

/** Where an older init wrote a managed server's plugins, which the config lists now. */
const PLUGINS_FILE_PATH = "hotUpdater.plugins.ts";

/**
 * Whether `text` is the plugins file an older init wrote: comments and a
 * re-export of a provider package's `plugins`, which the config imports now.
 */
const isGeneratedPluginsFile = (text: string) =>
  /^export\{plugins\}from(["'])@hot-updater\/[\w-]+\1;?$/u.test(
    text.replace(/^\s*\/\/.*$/gmu, "").replace(/\s+/gu, ""),
  );

/**
 * Writes hot-updater.config.ts and says what it did. `settings` names the
 * provider in messages, such as "Supabase". A config it cannot merge is
 * kept, with what to add to it. The plugins file an older init wrote is
 * removed; one the project wrote is named, since nothing reads it.
 */
export const writeHotUpdaterFiles = async (
  scaffold: HotUpdaterConfigScaffold,
  { cwd = process.cwd(), settings }: { cwd?: string; settings: string },
): Promise<{
  readonly config: WriteHotUpdaterConfigResult;
  /** What became of hotUpdater.plugins.ts, when there was one. */
  readonly pluginsFile?: "removed" | "kept";
}> => {
  const config = await writeHotUpdaterConfig(
    scaffold,
    path.join(cwd, HOT_UPDATER_CONFIG_PATH),
  );
  if (config.status === "created") {
    p.log.success(
      `Generated '${HOT_UPDATER_CONFIG_PATH}' file with ${settings} settings.`,
    );
  } else if (config.status === "merged") {
    p.log.success(
      `Updated '${HOT_UPDATER_CONFIG_PATH}' file with ${settings} settings.`,
    );
  } else {
    p.log.warn(
      [
        `Kept existing '${HOT_UPDATER_CONFIG_PATH}' unchanged: ${config.reason}`,
        `Set storage, database, and plugins in its config, as init writes them for ${settings}:`,
        "",
        renderServerSettings(scaffold),
      ].join("\n"),
    );
  }

  const pluginsPath = path.join(cwd, PLUGINS_FILE_PATH);
  const pluginsText = await readTextFile(pluginsPath);
  if (pluginsText === null) return { config };
  if (isGeneratedPluginsFile(pluginsText)) {
    await fs.rm(pluginsPath);
    p.log.success(
      `Removed '${PLUGINS_FILE_PATH}': \`plugins\` in '${HOT_UPDATER_CONFIG_PATH}' lists the plugins the server runs.`,
    );
    return { config, pluginsFile: "removed" };
  }
  p.log.warn(
    `Nothing reads '${pluginsPath}' anymore: \`plugins\` in '${HOT_UPDATER_CONFIG_PATH}' lists the plugins the server runs. Delete it.`,
  );
  return { config, pluginsFile: "kept" };
};
