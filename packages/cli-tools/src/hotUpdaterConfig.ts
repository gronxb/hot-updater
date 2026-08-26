import fs from "fs/promises";

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
  extraImports?: ImportInfo[];
  helperStatements?: ManagedHelperStatement[];
  updateStrategy?: "appVersion" | "fingerprint";
  authorityIdInitializer?: string;
};

export type CreateHotUpdaterConfigScaffoldFromBuilderOptions = {
  helperStatements?: ManagedHelperStatement[];
  updateStrategy?: "appVersion" | "fingerprint";
  authorityIdInitializer?: string;
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
  helperStatements: ManagedHelperStatement[];
  updateStrategy: string;
  authorityIdInitializer?: string;
};

export type WriteHotUpdaterConfigResult = {
  status: "created" | "merged" | "skipped";
  path: string;
  reason?: string;
};

const HOT_UPDATER_CONFIG_PATH = "hot-updater.config.ts";
const CONFIG_FILE_NAME = "hot-updater.config.ts";
const MANAGED_IMPORT_PACKAGES = new Set([
  "dotenv",
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

type ConfigSource = {
  readonly program: Program;
  readonly text: string;
};

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
  const edits: Array<{ start: number; end: number; text: string }> = [];

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

  let mergedText = existingText;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    mergedText =
      mergedText.slice(0, edit.start) + edit.text + mergedText.slice(edit.end);
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
    .map((property) => getNodeText(newObject.source, property));

  return appendMissingProperties(
    mergedText,
    missingPropertyTexts,
    existingObject.objectExpression.properties.length > 0,
  );
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

const updateManagedObject = (
  existing: ManagedConfigObject,
  next: ManagedConfigObject,
) => {
  const objectStart = existing.objectExpression.start;
  const objectText = getNodeText(existing.source, existing.objectExpression);
  const propertyEdits: Array<{ start: number; end: number; text: string }> = [];
  const missingPropertyTexts: string[] = [];

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
      missingPropertyTexts.push(getNodeText(next.source, nextProperty));
      continue;
    }

    const existingCallee = getCallCallee(existingProperty.value);
    const nextCallee = getCallCallee(nextProperty.value);
    if (!existingCallee || !nextCallee) {
      return null;
    }

    let nextInitializerText = getNodeText(next.source, nextProperty.value);
    if (propertyName === "build") {
      if (existingCallee === nextCallee) {
        continue;
      }

      if (!KNOWN_BUILD_CALLEES.has(existingCallee)) {
        return null;
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

  const nextAuthority = findManagedProperty(
    next.objectExpression,
    "authorityId",
  );
  if (nextAuthority) {
    const existingAuthority = findManagedProperty(
      existing.objectExpression,
      "authorityId",
    );
    if (existingAuthority) {
      propertyEdits.push({
        start: existingAuthority.value.start - objectStart,
        end: existingAuthority.value.end - objectStart,
        text: getNodeText(next.source, nextAuthority.value),
      });
    } else {
      missingPropertyTexts.push(getNodeText(next.source, nextAuthority));
    }
  }

  let mergedText = objectText;
  for (const edit of propertyEdits.sort(
    (left, right) => right.start - left.start,
  )) {
    mergedText =
      mergedText.slice(0, edit.start) + edit.text + mergedText.slice(edit.end);
  }

  return appendMissingProperties(
    mergedText,
    missingPropertyTexts,
    existing.objectExpression.properties.length > 0,
  );
};

const isConfigCallStatement = (statement: TopLevelStatement) =>
  statement.type === "ExpressionStatement" &&
  statement.expression.type === "CallExpression" &&
  statement.expression.callee.type === "Identifier" &&
  statement.expression.callee.name === "config";

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
  const importDeclarations = source.program.body.filter(
    (statement) => statement.type === "ImportDeclaration",
  );
  const firstImport = importDeclarations[0];
  const lastImport = importDeclarations.at(-1);
  if (!firstImport || !lastImport) {
    return {
      start: 0,
      end: 0,
      text: `${renderImportStatements(scaffold.imports)}\n\n`,
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
  const managedImportText = renderImportStatements(scaffold.imports);
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
  const configStatements: string[] = [];

  for (const statement of statementsBeforeExport) {
    if (isConfigCallStatement(statement)) {
      configStatements.push(getStatementText(source, statement));
      continue;
    }

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
  const configStatement =
    configStatements.join("\n\n") || `config({ path: ".env.hotupdater" });`;
  const managedBody = bodyText
    ? `\n\n${configStatement}\n\n${bodyText}\n\n`
    : `\n\n${configStatement}\n\n`;
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

  return {
    text: applyTextEdits(existingText, [
      {
        start: existingConfig.objectExpression.start,
        end: existingConfig.objectExpression.end,
        text: nextObjectText,
      },
      bodyEdit,
      rebuildImportBlock(existingSource, scaffold),
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
  extraImports = [],
  helperStatements = [],
  updateStrategy = "appVersion",
  authorityIdInitializer,
}: CreateHotUpdaterConfigScaffoldOptions): HotUpdaterConfigScaffold => {
  const intermediateCode = helperStatements
    .map((statement) => statement.code.trim())
    .filter(Boolean)
    .join("\n\n");

  const builder = new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storage)
    .setDatabase(database);

  for (const extraImport of extraImports) {
    builder.addImport(extraImport);
  }

  if (intermediateCode) {
    builder.setIntermediateCode(intermediateCode);
  }

  return createHotUpdaterConfigScaffoldFromBuilder(builder, {
    helperStatements,
    updateStrategy,
    authorityIdInitializer,
  });
};

export const createHotUpdaterConfigScaffoldFromBuilder = (
  builder: ConfigBuilder,
  {
    helperStatements = [],
    updateStrategy = "appVersion",
    authorityIdInitializer,
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
  const text = authorityIdInitializer
    ? strategyText.replace(
        "export default defineConfig({",
        `export default defineConfig({\n  authorityId: ${authorityIdInitializer},`,
      )
    : strategyText;
  return {
    text,
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
    helperStatements,
    updateStrategy: `"${updateStrategy}"`,
    ...(authorityIdInitializer ? { authorityIdInitializer } : {}),
  };
};

export const writeHotUpdaterConfig = async (
  scaffold: HotUpdaterConfigScaffold,
  filePath = HOT_UPDATER_CONFIG_PATH,
): Promise<WriteHotUpdaterConfigResult> => {
  const existingText = await fs.readFile(filePath, "utf-8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  });

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
