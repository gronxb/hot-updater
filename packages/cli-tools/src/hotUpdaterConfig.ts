import fs from "fs/promises";

import ts from "typescript";

import {
  type BuildType,
  ConfigBuilder,
  renderImportStatements,
  type ImportInfo,
  type ProviderConfig,
} from "./ConfigBuilder";

export type ManagedHelperStrategy =
  | "merge-object"
  | "preserve-existing"
  | "replace";

export type ManagedHelperStatement = {
  name: string;
  code: string;
  strategy: ManagedHelperStrategy;
};

export type CreateHotUpdaterConfigScaffoldOptions = {
  build: BuildType;
  storage: ProviderConfig;
  database: ProviderConfig;
  extraImports?: ImportInfo[];
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
  helperStatements: ManagedHelperStatement[];
  updateStrategy: string;
};

export type WriteHotUpdaterConfigResult = {
  status: "created" | "merged" | "skipped";
  path: string;
  reason?: string;
};

const HOT_UPDATER_CONFIG_PATH = "hot-updater.config.ts";
const WRAP_PREFIX = "const __hotUpdaterValue = ";
const WRAP_SUFFIX = ";";
const MANAGED_IMPORT_PACKAGES = new Set([
  "dotenv",
  "firebase-admin",
  "hot-updater",
  "@aws-sdk/credential-provider-sso",
  "@hot-updater/aws",
  "@hot-updater/bare",
  "@hot-updater/cloudflare",
  "@hot-updater/expo",
  "@hot-updater/firebase",
  "@hot-updater/rock",
  "@hot-updater/supabase",
]);
const MANAGED_HELPER_NAMES = new Set(["commonOptions", "credential"]);
const KNOWN_BUILD_CALLEES = new Set(["bare", "expo", "rock"]);

const createSnippetSourceFile = (code: string) =>
  ts.createSourceFile(
    "hot-updater-config-snippet.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

const extractCallIdentifier = (initializer: string) => {
  const match = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(initializer);
  if (!match) {
    throw new Error(`Failed to extract call identifier from "${initializer}"`);
  }

  return match[1];
};

const wrapExpression = (expression: string) =>
  `${WRAP_PREFIX}${expression}${WRAP_SUFFIX}`;

const getWrappedObjectLiteral = (text: string) => {
  const sourceFile = createSnippetSourceFile(wrapExpression(text));
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) {
    return null;
  }

  const declaration = statement.declarationList.declarations[0];
  if (!declaration || !declaration.initializer) {
    return null;
  }

  if (!ts.isObjectLiteralExpression(declaration.initializer)) {
    return null;
  }

  return {
    sourceFile,
    objectLiteral: declaration.initializer,
    offset: WRAP_PREFIX.length,
  };
};

const parseVariableStatement = (code: string) => {
  const sourceFile = createSnippetSourceFile(code);
  const statement = sourceFile.statements.find((node) =>
    ts.isVariableStatement(node),
  );

  if (!statement || !ts.isVariableStatement(statement)) {
    return null;
  }

  const declaration = statement.declarationList.declarations[0];
  if (
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer
  ) {
    return null;
  }

  return {
    sourceFile,
    statement,
    declaration,
  };
};

const getPropertyName = (
  property:
    | ts.ObjectLiteralElementLike
    | ts.PropertyName
    | ts.ObjectLiteralElement,
): string | null => {
  if (
    ts.isIdentifier(property) ||
    ts.isStringLiteral(property) ||
    ts.isNumericLiteral(property)
  ) {
    return property.text;
  }

  if (ts.isSpreadAssignment(property)) {
    return null;
  }

  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text;
  }

  if (
    ts.isPropertyAssignment(property) ||
    ts.isMethodDeclaration(property) ||
    ts.isGetAccessorDeclaration(property) ||
    ts.isSetAccessorDeclaration(property)
  ) {
    const { name } = property;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
      return name.text;
    }

    if (ts.isNumericLiteral(name)) {
      return name.text;
    }
  }

  return null;
};

const trimStatementText = (text: string) => text.trim();

const getStatementText = (sourceText: string, statement: ts.Statement) =>
  trimStatementText(sourceText.slice(statement.getFullStart(), statement.end));

const getObjectTrailingComma = (text: string) => {
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
    .map((line) => line.match(/^\s*/)![0].length);
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
  propertyTexts: string[],
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
    ? getObjectTrailingComma(objectText)
      ? "\n"
      : ",\n"
    : "\n";
  const suffix = `,\n${closingIndent}`;

  return `${objectText.slice(0, closeBraceIndex)}${prefix}${formattedProperties}${suffix}${objectText.slice(closeBraceIndex)}`;
};

const mergeObjectLiteralText = (
  existingText: string,
  newText: string,
): string | null => {
  const existingWrapped = getWrappedObjectLiteral(existingText);
  const newWrapped = getWrappedObjectLiteral(newText);

  if (!existingWrapped || !newWrapped) {
    return null;
  }

  const existingPropertyNames = new Set<string>();
  const existingSpreadTexts = new Set<string>();
  const edits: Array<{ start: number; end: number; text: string }> = [];

  for (const property of existingWrapped.objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      existingSpreadTexts.add(
        property.expression.getText(existingWrapped.sourceFile).trim(),
      );
      continue;
    }

    const propertyName = getPropertyName(property);
    if (!propertyName) {
      continue;
    }

    existingPropertyNames.add(propertyName);
    const nextProperty = newWrapped.objectLiteral.properties.find((candidate) => {
      if (ts.isSpreadAssignment(candidate)) {
        return false;
      }

      return getPropertyName(candidate) === propertyName;
    });

    if (
      !nextProperty ||
      !ts.isPropertyAssignment(property) ||
      !ts.isPropertyAssignment(nextProperty)
    ) {
      continue;
    }

    if (
      ts.isObjectLiteralExpression(property.initializer) &&
      ts.isObjectLiteralExpression(nextProperty.initializer)
    ) {
      const mergedInitializer = mergeObjectLiteralText(
        property.initializer.getText(existingWrapped.sourceFile),
        nextProperty.initializer.getText(newWrapped.sourceFile),
      );
      if (!mergedInitializer) {
        return null;
      }

      edits.push({
        start:
          property.initializer.getStart(existingWrapped.sourceFile) -
          existingWrapped.offset,
        end: property.initializer.end - existingWrapped.offset,
        text: mergedInitializer,
      });
    }
  }

  let mergedText = existingText;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    mergedText =
      mergedText.slice(0, edit.start) +
      edit.text +
      mergedText.slice(edit.end);
  }

  const missingPropertyTexts = newWrapped.objectLiteral.properties
    .filter((property) => {
      if (ts.isSpreadAssignment(property)) {
        return !existingSpreadTexts.has(
          property.expression.getText(newWrapped.sourceFile).trim(),
        );
      }

      const propertyName = getPropertyName(property);
      return propertyName ? !existingPropertyNames.has(propertyName) : false;
    })
    .map((property) => property.getText(newWrapped.sourceFile));

  return appendMissingProperties(
    mergedText,
    missingPropertyTexts,
    existingWrapped.objectLiteral.properties.length > 0,
  );
};

const buildMergedCallInitializer = (
  existingCall: ts.CallExpression,
  existingSourceFile: ts.SourceFile,
  newCall: ts.CallExpression,
  newSourceFile: ts.SourceFile,
) => {
  const existingCallee = existingCall.expression.getText(existingSourceFile);
  const [existingArg] = existingCall.arguments;
  const [newArg] = newCall.arguments;

  if (
    existingCall.arguments.length === 1 &&
    newCall.arguments.length === 1 &&
    existingArg &&
    newArg &&
    ts.isObjectLiteralExpression(existingArg) &&
    ts.isObjectLiteralExpression(newArg)
  ) {
    const mergedObjectLiteral = mergeObjectLiteralText(
      existingArg.getText(existingSourceFile),
      newArg.getText(newSourceFile),
    );
    if (!mergedObjectLiteral) {
      return null;
    }

    return `${existingCallee}(${mergedObjectLiteral})`;
  }

  return existingCall.getText(existingSourceFile);
};

const findDefineConfigObject = (sourceFile: ts.SourceFile) => {
  const exportAssignment = sourceFile.statements.find((statement) => {
    if (!ts.isExportAssignment(statement)) {
      return false;
    }

    const expression = statement.expression;
    if (!ts.isCallExpression(expression)) {
      return false;
    }

    return (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "defineConfig" &&
      expression.arguments.length > 0 &&
      ts.isObjectLiteralExpression(expression.arguments[0]!)
    );
  });

  if (!exportAssignment || !ts.isExportAssignment(exportAssignment)) {
    return null;
  }

  const expression = exportAssignment.expression;
  if (!ts.isCallExpression(expression)) {
    return null;
  }

  const [argument] = expression.arguments;
  if (!argument || !ts.isObjectLiteralExpression(argument)) {
    return null;
  }

  return {
    exportAssignment,
    objectLiteral: argument,
  };
};

const findManagedProperty = (
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
) =>
  objectLiteral.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      getPropertyName(property.name) === propertyName,
  );

const getCallCallee = (expression: ts.Expression) => {
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
    return null;
  }

  return expression.expression.text;
};

const isConfigCallStatement = (statement: ts.Statement) =>
  ts.isExpressionStatement(statement) &&
  ts.isCallExpression(statement.expression) &&
  ts.isIdentifier(statement.expression.expression) &&
  statement.expression.expression.text === "config";

const isManagedHelperStatement = (statement: ts.Statement) => {
  if (!ts.isVariableStatement(statement)) {
    return null;
  }

  const declaration = statement.declarationList.declarations[0];
  if (!declaration || !ts.isIdentifier(declaration.name)) {
    return null;
  }

  return MANAGED_HELPER_NAMES.has(declaration.name.text)
    ? declaration.name.text
    : null;
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

  const existingInitializer = existingStatement.declaration.initializer;
  const newInitializer = nextStatement.declaration.initializer;

  if (
    !existingInitializer ||
    !newInitializer ||
    !ts.isObjectLiteralExpression(existingInitializer) ||
    !ts.isObjectLiteralExpression(newInitializer)
  ) {
    return null;
  }

  const mergedInitializer = mergeObjectLiteralText(
    existingInitializer.getText(existingStatement.sourceFile),
    newInitializer.getText(nextStatement.sourceFile),
  );
  if (!mergedInitializer) {
    return null;
  }

  const keyword = ts.tokenToString(
    existingStatement.statement.declarationList.flags & ts.NodeFlags.Const
      ? ts.SyntaxKind.ConstKeyword
      : existingStatement.statement.declarationList.flags & ts.NodeFlags.Let
        ? ts.SyntaxKind.LetKeyword
        : ts.SyntaxKind.VarKeyword,
  );

  return `${keyword ?? "const"} ${helper.name} = ${mergedInitializer};`;
};

const updateManagedObject = (
  existingText: string,
  existingObject: ts.ObjectLiteralExpression,
  newObject: ts.ObjectLiteralExpression,
  existingSourceFile: ts.SourceFile,
  newSourceFile: ts.SourceFile,
) => {
  const objectStart = existingObject.getStart(existingSourceFile);
  const objectText = existingText.slice(objectStart, existingObject.end);
  const propertyEdits: Array<{ start: number; end: number; text: string }> = [];
  const missingPropertyTexts: string[] = [];

  const managedPropertyNames = ["build", "storage", "database"];
  for (const propertyName of managedPropertyNames) {
    const existingProperty = findManagedProperty(existingObject, propertyName);
    const nextProperty = findManagedProperty(newObject, propertyName);

    if (!nextProperty) {
      continue;
    }

    if (!existingProperty) {
      missingPropertyTexts.push(nextProperty.getText(newSourceFile));
      continue;
    }

    if (!ts.isCallExpression(existingProperty.initializer)) {
      return null;
    }

    if (!ts.isCallExpression(nextProperty.initializer)) {
      return null;
    }

    const existingCallee = getCallCallee(existingProperty.initializer);
    const nextCallee = getCallCallee(nextProperty.initializer);
    if (!existingCallee || !nextCallee) {
      return null;
    }

    let nextInitializerText = nextProperty.initializer.getText(newSourceFile);

    if (propertyName === "build") {
      if (existingCallee === nextCallee) {
        continue;
      }

      if (!KNOWN_BUILD_CALLEES.has(existingCallee)) {
        return null;
      }
    } else if (existingCallee === nextCallee) {
      const mergedInitializer = buildMergedCallInitializer(
        existingProperty.initializer,
        existingSourceFile,
        nextProperty.initializer,
        newSourceFile,
      );
      if (mergedInitializer === null) {
        return null;
      }

      nextInitializerText = mergedInitializer;
    }

    propertyEdits.push({
      start: existingProperty.initializer.getStart(existingSourceFile) - objectStart,
      end: existingProperty.initializer.end - objectStart,
      text: nextInitializerText,
    });
  }

  let mergedText = objectText;
  for (const edit of propertyEdits.sort((a, b) => b.start - a.start)) {
    mergedText =
      mergedText.slice(0, edit.start) +
      edit.text +
      mergedText.slice(edit.end);
  }

  return appendMissingProperties(
    mergedText,
    missingPropertyTexts,
    existingObject.properties.length > 0,
  );
};

const rebuildImportBlock = (
  sourceText: string,
  sourceFile: ts.SourceFile,
  scaffold: HotUpdaterConfigScaffold,
) => {
  const importDeclarations = sourceFile.statements.filter(ts.isImportDeclaration);
  if (importDeclarations.length === 0) {
    return {
      start: 0,
      end: 0,
      text: `${renderImportStatements(scaffold.imports)}\n\n`,
    };
  }

  const preservedImportTexts = importDeclarations
    .filter((declaration) => {
      const moduleSpecifier = declaration.moduleSpecifier;
      return (
        ts.isStringLiteral(moduleSpecifier) &&
        !MANAGED_IMPORT_PACKAGES.has(moduleSpecifier.text)
      );
    })
    .map((declaration) => trimStatementText(sourceText.slice(declaration.getFullStart(), declaration.end)));

  const managedImportText = renderImportStatements(scaffold.imports);
  const nextImportBlock = [...preservedImportTexts, managedImportText]
    .filter(Boolean)
    .join("\n");

  return {
    start: importDeclarations[0]!.getFullStart(),
    end: importDeclarations.at(-1)!.end,
    text: `${nextImportBlock}\n\n`,
  };
};

const rebuildManagedBody = (
  sourceText: string,
  sourceFile: ts.SourceFile,
  exportAssignment: ts.ExportAssignment,
  scaffold: HotUpdaterConfigScaffold,
) => {
  const statementsBeforeExport = sourceFile.statements.filter(
    (statement) =>
      !ts.isImportDeclaration(statement) && statement.pos < exportAssignment.pos,
  );
  const managedHelpers = new Map(
    scaffold.helperStatements.map((statement) => [statement.name, statement]),
  );
  const emittedHelpers = new Set<string>();
  const bodyStatements: string[] = [];

  for (const statement of statementsBeforeExport) {
    if (isConfigCallStatement(statement)) {
      continue;
    }

    const helperName = isManagedHelperStatement(statement);
    if (!helperName) {
      bodyStatements.push(getStatementText(sourceText, statement));
      continue;
    }

    const helper = managedHelpers.get(helperName);
    if (!helper) {
      continue;
    }

    const mergedHelperStatement = mergeHelperStatement(
      getStatementText(sourceText, statement),
      helper,
    );
    if (!mergedHelperStatement) {
      return null;
    }

    emittedHelpers.add(helperName);
    bodyStatements.push(mergedHelperStatement);
  }

  for (const helper of scaffold.helperStatements) {
    if (!emittedHelpers.has(helper.name)) {
      bodyStatements.push(helper.code.trim());
    }
  }

  const bodyText = bodyStatements.filter(Boolean).join("\n\n");
  const configStatement = `config({ path: ".env.hotupdater" });`;
  const managedBody = bodyText
    ? `\n\n${configStatement}\n\n${bodyText}\n\n`
    : `\n\n${configStatement}\n\n`;

  const bodyStart =
    sourceFile.statements.filter(ts.isImportDeclaration).at(-1)?.end ?? 0;

  return {
    start: bodyStart,
    end: exportAssignment.getFullStart(),
    text: managedBody,
  };
};

export const createHotUpdaterConfigScaffold = ({
  build,
  storage,
  database,
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
    .setDatabase(database);

  for (const extraImport of extraImports) {
    builder.addImport(extraImport);
  }

  if (intermediateCode) {
    builder.setIntermediateCode(intermediateCode);
  }

  const scaffold = builder.getScaffold();
  return {
    text:
      updateStrategy === "appVersion"
        ? scaffold.text
        : scaffold.text.replace(
            'updateStrategy: "appVersion"',
            `updateStrategy: "${updateStrategy}"`,
          ),
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
  };
};

export const writeHotUpdaterConfig = async (
  scaffold: HotUpdaterConfigScaffold,
  filePath = HOT_UPDATER_CONFIG_PATH,
): Promise<WriteHotUpdaterConfigResult> => {
  const existingText = await fs.readFile(filePath, "utf-8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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

  const existingSourceFile = createSnippetSourceFile(existingText);
  const existingConfig = findDefineConfigObject(existingSourceFile);
  const nextSourceFile = createSnippetSourceFile(scaffold.text);
  const nextConfig = findDefineConfigObject(nextSourceFile);

  if (!existingConfig || !nextConfig) {
    return {
      status: "skipped",
      path: filePath,
      reason:
        "Existing config is not a supported `export default defineConfig({ ... })` shape.",
    };
  }

  const nextObjectText = updateManagedObject(
    existingText,
    existingConfig.objectLiteral,
    nextConfig.objectLiteral,
    existingSourceFile,
    nextSourceFile,
  );
  if (!nextObjectText) {
    return {
      status: "skipped",
      path: filePath,
      reason:
        "Existing config uses dynamic build/storage/database expressions that cannot be merged safely.",
    };
  }

  const objectEdit = {
    start: existingConfig.objectLiteral.getStart(existingSourceFile),
    end: existingConfig.objectLiteral.end,
    text: nextObjectText,
  };
  const importEdit = rebuildImportBlock(existingText, existingSourceFile, scaffold);
  const bodyEdit = rebuildManagedBody(
    existingText,
    existingSourceFile,
    existingConfig.exportAssignment,
    scaffold,
  );

  if (!bodyEdit) {
    return {
      status: "skipped",
      path: filePath,
      reason: "Existing helper declarations could not be merged safely.",
    };
  }

  let mergedText = existingText;
  for (const edit of [objectEdit, bodyEdit, importEdit].sort(
    (a, b) => b.start - a.start,
  )) {
    mergedText =
      mergedText.slice(0, edit.start) +
      edit.text +
      mergedText.slice(edit.end);
  }

  await fs.writeFile(filePath, mergedText, "utf-8");
  return {
    status: "merged",
    path: filePath,
  };
};
