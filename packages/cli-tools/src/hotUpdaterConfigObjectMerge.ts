import type {
  CallExpression,
  ObjectExpression,
  ObjectProperty,
  ObjectPropertyKind,
} from "oxc-parser";

import { type ConfigSource, getNodeText } from "./hotUpdaterConfigAst";

type CallSource = {
  readonly callExpression: CallExpression;
  readonly source: ConfigSource;
};

export type ObjectSource = {
  readonly objectExpression: ObjectExpression;
  readonly source: ConfigSource;
};

export const getObjectPropertyName = (
  property: ObjectPropertyKind,
): string | null => {
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

export const appendMissingProperties = (
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

export const mergeObjectLiteralText = (
  existingObject: ObjectSource,
  newObject: ObjectSource,
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

export const buildMergedCallInitializer = (
  existing: CallSource,
  next: CallSource,
) => {
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
