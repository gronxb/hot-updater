import type { Expression, ObjectExpression, ObjectProperty } from "oxc-parser";

import type { ManagedHelperStatement } from "./hotUpdaterConfig";
import {
  type ConfigSource,
  getNodeText,
  parseVariableStatement,
} from "./hotUpdaterConfigAst";
import {
  appendMissingProperties,
  buildMergedCallInitializer,
  getObjectPropertyName,
  mergeObjectLiteralText,
} from "./hotUpdaterConfigObjectMerge";

const KNOWN_BUILD_CALLEES = new Set(["bare", "expo", "rock"]);

export type ManagedConfigObject = {
  readonly objectExpression: ObjectExpression;
  readonly source: ConfigSource;
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

export const mergeHelperStatement = (
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

export const updateManagedObject = (
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
