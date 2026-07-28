import {
  parseSync,
  type ExportDefaultDeclaration,
  type ObjectExpression,
  type Program,
  type Span,
  type VariableDeclaration,
  type VariableDeclarator,
} from "oxc-parser";

const CONFIG_FILE_NAME = "hot-updater.config.ts";

export type ConfigSource = {
  readonly program: Program;
  readonly text: string;
};

export type TopLevelStatement = Program["body"][number];

export type ConfigObject = {
  readonly exportDeclaration: ExportDefaultDeclaration;
  readonly objectExpression: ObjectExpression;
};

export type ParsedVariableStatement = {
  readonly source: ConfigSource;
  readonly statement: VariableDeclaration;
  readonly declaration: VariableDeclarator;
};

export const parseConfigSource = (text: string): ConfigSource | null => {
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

export const getNodeText = (source: ConfigSource, node: Span) =>
  source.text.slice(node.start, node.end);

export const getTopLevelFullStart = (
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

export const getStatementText = (
  source: ConfigSource,
  statement: TopLevelStatement,
) =>
  source.text
    .slice(getTopLevelFullStart(source, statement), statement.end)
    .trim();

export const parseVariableStatement = (
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

export const findDefineConfigObject = (
  source: ConfigSource,
): ConfigObject | null => {
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
      declaration.arguments[0]?.type === "ObjectExpression"
    );
  });

  if (exportDeclaration?.type !== "ExportDefaultDeclaration") {
    return null;
  }

  const declaration = exportDeclaration.declaration;
  if (declaration.type !== "CallExpression") {
    return null;
  }

  const objectExpression = declaration.arguments[0];
  if (objectExpression?.type !== "ObjectExpression") {
    return null;
  }

  return {
    exportDeclaration,
    objectExpression,
  };
};
