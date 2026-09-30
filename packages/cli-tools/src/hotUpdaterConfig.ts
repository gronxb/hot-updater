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
} from "oxc-parser";

import {
  type BuildType,
  ConfigBuilder,
  type ImportInfo,
  type ProviderConfig,
  renderImportStatements,
} from "./ConfigBuilder";

export type CreateHotUpdaterConfigScaffoldOptions = {
  build: BuildType;
  storage: ProviderConfig;
  database: ProviderConfig;
  plugins: ProviderConfig;
  /** Imports the server definition's intermediate code needs. */
  extraImports?: ImportInfo[];
  /** Code between the server definition's imports and the server, such as a credentials helper. */
  intermediateCode?: string;
  updateStrategy?: "appVersion" | "fingerprint";
};

export type CreateHotUpdaterConfigScaffoldFromBuilderOptions = {
  updateStrategy?: "appVersion" | "fingerprint";
};

export type HotUpdaterConfigScaffold = {
  /** hot-updater.config.ts. */
  text: string;
  imports: ImportInfo[];
  build: {
    initializer: string;
    callee: string;
  };
  /** The `server` path hot-updater.config.ts points at. */
  server: string;
  updateStrategy: string;
  /** The server definition `server` points at. */
  definition: {
    text: string;
    imports: ImportInfo[];
    storage: {
      initializer: string;
      callee: string;
    };
    database: {
      initializer: string;
      callee: string;
    };
    intermediateCode: string;
  };
};

export type WriteHotUpdaterConfigResult = {
  status: "created" | "merged" | "skipped";
  path: string;
  reason?: string;
  /**
   * The `server` path the written file points at, when it is a string
   * literal: the scaffold's, or one the file already set.
   */
  server?: string;
};

export type WriteServerDefinitionResult = {
  /**
   * `kept` when the file already defines another server: the project's own,
   * which init never overwrites.
   */
  status: "created" | "unchanged" | "kept";
  path: string;
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
/**
 * Helpers older configs declared for storage and database, which moved to
 * the server definition.
 */
const MOVED_HELPER_NAMES = new Set([
  "awsOptions",
  "commonOptions",
  "credential",
  "storageOptions",
]);
/** Properties older configs set, which moved to the server definition. */
const MOVED_PROPERTY_NAMES = ["storage", "database", "plugins"] as const;
const KNOWN_BUILD_CALLEES = new Set(["bare", "expo", "rock"]);

type ConfigSource = {
  readonly program: Program;
  readonly text: string;
};

type TopLevelStatement = Program["body"][number];

type ConfigObject = {
  readonly exportDeclaration: ExportDefaultDeclaration;
  readonly objectExpression: ObjectExpression;
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

const hasTrailingComma = (text: string) => {
  const closeBraceIndex = text.lastIndexOf("}");
  if (closeBraceIndex === -1) {
    return false;
  }

  let index = closeBraceIndex - 1;
  while (index >= 0 && /\s/.test(text[index] ?? "")) {
    index -= 1;
  }

  return (text[index] ?? "") === ",";
};

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

const appendMissingProperties = (
  objectText: string,
  propertyTexts: readonly string[],
  hasExistingProperties: boolean,
) => {
  if (propertyTexts.length === 0) {
    return objectText;
  }

  const closingBraceMatch = /\n([ \t]*)\}$/.exec(objectText);
  const closingIndent = closingBraceMatch?.[1] ?? "";
  const childIndent =
    objectText.match(/\n([ \t]+)[^\s]/)?.[1] ?? `${closingIndent}  `;
  const formattedProperties = propertyTexts
    .map((propertyText) => indentBlock(propertyText, childIndent))
    .join(",\n");
  const closeBraceIndex = objectText.lastIndexOf("}");
  if (closeBraceIndex === -1) {
    return objectText;
  }

  const prefix = hasExistingProperties
    ? hasTrailingComma(objectText)
      ? "\n"
      : ",\n"
    : "\n";
  const suffix = `,\n${closingIndent}`;

  return `${objectText.slice(0, closeBraceIndex)}${prefix}${formattedProperties}${suffix}${objectText.slice(closeBraceIndex)}`;
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

const getCallCallee = (expression: Expression) => {
  if (
    expression.type !== "CallExpression" ||
    expression.callee.type !== "Identifier"
  ) {
    return null;
  }

  return expression.callee.name;
};

/**
 * The removal of `property` from the object `objectText` starts at
 * `objectStart`, with its trailing comma and its line's indentation.
 */
const removePropertyEdit = (
  objectText: string,
  objectStart: number,
  property: ObjectPropertyKind,
): TextEdit => {
  let start = property.start - objectStart;
  let end = property.end - objectStart;
  const trailingComma = /^\s*,[ \t]*\n?/.exec(objectText.slice(end));
  if (trailingComma) end += trailingComma[0].length;
  const indentation = /\n([ \t]*)$/.exec(objectText.slice(0, start));
  if (indentation) start -= indentation[1]!.length;
  return { start, end, text: "" };
};

/**
 * The config object with the scaffold's `build`, its `server` unless the
 * config already points somewhere, and without the settings that moved to
 * the server definition; null when `build` is dynamic.
 */
const updateManagedObject = (
  existing: ManagedConfigObject,
  next: ManagedConfigObject,
) => {
  const objectStart = existing.objectExpression.start;
  const objectText = getNodeText(existing.source, existing.objectExpression);
  const edits: TextEdit[] = [];
  const missingPropertyTexts: string[] = [];

  const existingBuild = findManagedProperty(existing.objectExpression, "build");
  const nextBuild = findManagedProperty(next.objectExpression, "build");
  if (nextBuild) {
    if (!existingBuild) {
      missingPropertyTexts.push(getNodeText(next.source, nextBuild));
    } else {
      const existingCallee = getCallCallee(existingBuild.value);
      const nextCallee = getCallCallee(nextBuild.value);
      if (!existingCallee || !nextCallee) {
        return null;
      }
      if (existingCallee !== nextCallee) {
        if (!KNOWN_BUILD_CALLEES.has(existingCallee)) {
          return null;
        }
        edits.push({
          start: existingBuild.value.start - objectStart,
          end: existingBuild.value.end - objectStart,
          text: getNodeText(next.source, nextBuild.value),
        });
      }
    }
  }

  const hasServer = existing.objectExpression.properties.some(
    (property) => getObjectPropertyName(property) === "server",
  );
  const nextServer = findManagedProperty(next.objectExpression, "server");
  if (!hasServer && nextServer) {
    missingPropertyTexts.push(getNodeText(next.source, nextServer));
  }

  for (const property of existing.objectExpression.properties) {
    const name = getObjectPropertyName(property);
    if (
      name !== null &&
      (MOVED_PROPERTY_NAMES as readonly string[]).includes(name)
    ) {
      edits.push(removePropertyEdit(objectText, objectStart, property));
    }
  }

  const remainingProperties =
    existing.objectExpression.properties.length -
    edits.filter((edit) => edit.text === "").length;
  return appendMissingProperties(
    applyTextEdits(objectText, edits),
    missingPropertyTexts,
    remainingProperties > 0,
  );
};

/** The string literal `server` of a config object, if it sets one. */
const findServerPointer = (objectExpression: ObjectExpression) => {
  const server = findManagedProperty(objectExpression, "server");
  return server?.value.type === "Literal" &&
    typeof server.value.value === "string"
    ? server.value.value
    : undefined;
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

const rebuildImportBlock = (
  source: ConfigSource,
  scaffold: HotUpdaterConfigScaffold,
): TextEdit => {
  // Keep environment-loading imports under the existing config's control.
  const imports = scaffold.imports.map((info) =>
    info.pkg === "node:fs"
      ? { ...info, named: info.named?.filter((name) => name !== "existsSync") }
      : info,
  );
  const importDeclarations = source.program.body.filter(
    (statement) => statement.type === "ImportDeclaration",
  );
  const firstImport = importDeclarations[0];
  const lastImport = importDeclarations.at(-1);
  if (!firstImport || !lastImport) {
    return {
      start: 0,
      end: 0,
      text: `${renderImportStatements(imports)}\n\n`,
    };
  }

  const preservedImportTexts = importDeclarations
    .filter(
      (declaration) => !MANAGED_IMPORT_PACKAGES.has(declaration.source.value),
    )
    .map((declaration) =>
      source.text
        .slice(getTopLevelFullStart(source, declaration), declaration.end)
        .trim(),
    );
  const managedImportText = renderImportStatements(imports);
  const nextImportBlock = [...preservedImportTexts, managedImportText]
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
): TextEdit => {
  const statementsBeforeExport = source.program.body.filter(
    (statement) =>
      statement.type !== "ImportDeclaration" && statement.start < exportStart,
  );
  const bodyStatements: string[] = [];

  for (const statement of statementsBeforeExport) {
    const helperName = getManagedHelperName(statement);
    // Helpers for storage and database moved with them.
    if (helperName && MOVED_HELPER_NAMES.has(helperName)) {
      continue;
    }
    bodyStatements.push(getStatementText(source, statement));
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
): ConfigTextMergeResult & { readonly server?: string } => {
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

  const nextObjectText = updateManagedObject(
    {
      objectExpression: existingConfig.objectExpression,
      source: existingSource,
    },
    {
      objectExpression: nextConfig.objectExpression,
      source: nextSource,
    },
  );
  if (!nextObjectText) {
    return {
      reason:
        "Existing config uses a dynamic build expression that cannot be merged safely.",
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
  const hasServer = existingConfig.objectExpression.properties.some(
    (property) => getObjectPropertyName(property) === "server",
  );
  const server = hasServer
    ? findServerPointer(existingConfig.objectExpression)
    : scaffold.server;

  return {
    text: applyTextEdits(existingText, [
      {
        start: existingConfig.objectExpression.start,
        end: existingConfig.objectExpression.end,
        text: nextObjectText,
      },
      rebuildManagedBody(existingSource, managedBodyEnd),
      rebuildImportBlock(existingSource, scaffold),
    ]),
    ...(server === undefined ? {} : { server }),
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
  intermediateCode = "",
  updateStrategy = "appVersion",
}: CreateHotUpdaterConfigScaffoldOptions): HotUpdaterConfigScaffold => {
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
    updateStrategy,
  });
};

export const createHotUpdaterConfigScaffoldFromBuilder = (
  builder: ConfigBuilder,
  {
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
    server: scaffold.server,
    updateStrategy: `"${updateStrategy}"`,
    definition: {
      text: scaffold.definition.text,
      imports: scaffold.definition.imports,
      storage: {
        initializer: scaffold.definition.storageConfigString,
        callee: extractCallIdentifier(scaffold.definition.storageConfigString),
      },
      database: {
        initializer: scaffold.definition.databaseConfigString,
        callee: extractCallIdentifier(scaffold.definition.databaseConfigString),
      },
      intermediateCode: scaffold.definition.intermediateCode,
    },
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
 * existing config with the scaffold's `build`, a `server` unless it already
 * points somewhere, and without the settings that moved to the server
 * definition.
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
      server: scaffold.server,
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
    ...(mergeResult.server === undefined ? {} : { server: mergeResult.server }),
  };
};

/**
 * How the server definition at `filePath` compares with the scaffold's:
 * `missing`, `unchanged`, or `edited`, the project's own.
 */
export const readServerDefinitionStatus = async (
  scaffold: HotUpdaterConfigScaffold,
  filePath: string,
): Promise<"missing" | "unchanged" | "edited"> => {
  const text = await readTextFile(filePath);
  if (text === null) return "missing";
  return text.trim() === scaffold.definition.text.trim()
    ? "unchanged"
    : "edited";
};

/**
 * Writes the server definition at `filePath` when it is missing. An
 * existing one is the project's own and stays as it is.
 */
export const writeServerDefinition = async (
  scaffold: HotUpdaterConfigScaffold,
  filePath: string,
): Promise<WriteServerDefinitionResult> => {
  const status = await readServerDefinitionStatus(scaffold, filePath);
  if (status === "missing") {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${scaffold.definition.text}\n`, "utf-8");
    return { status: "created", path: filePath };
  }
  return {
    status: status === "unchanged" ? "unchanged" : "kept",
    path: filePath,
  };
};
