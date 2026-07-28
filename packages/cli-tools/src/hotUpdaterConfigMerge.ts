import { renderImportStatements } from "./ConfigBuilder";
import type { HotUpdaterConfigScaffold } from "./hotUpdaterConfig";
import {
  type ConfigSource,
  findDefineConfigObject,
  getStatementText,
  getTopLevelFullStart,
  parseConfigSource,
  type TopLevelStatement,
} from "./hotUpdaterConfigAst";
import {
  mergeHelperStatement,
  updateManagedObject,
} from "./hotUpdaterConfigManagedMerge";

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

type TextEdit = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

export type ConfigTextMergeResult =
  | { readonly text: string }
  | { readonly reason: string };

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

  return MANAGED_HELPER_NAMES.has(declaration.id.name)
    ? declaration.id.name
    : null;
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
    text: `${nextImportBlock}\n\n`,
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
    if (isConfigCallStatement(statement)) {
      continue;
    }

    const helperName = getManagedHelperName(statement);
    if (!helperName) {
      bodyStatements.push(getStatementText(source, statement));
      continue;
    }

    const helper = managedHelpers.get(helperName);
    if (!helper) {
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
  const configStatement = `config({ path: ".env.hotupdater" });`;
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

export const mergeHotUpdaterConfigText = (
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

  const bodyEdit = rebuildManagedBody(
    existingSource,
    getTopLevelFullStart(existingSource, existingConfig.exportDeclaration),
    scaffold,
  );
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
