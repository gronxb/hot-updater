import { STORAGE_V2_PROVIDER_MATRIX } from "./capabilityMatrixData";

export { STORAGE_V2_PROVIDER_MATRIX } from "./capabilityMatrixData";

const JSON_INDENT = "  ";
const JSON_PRINT_WIDTH = 80;

function compactJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(compactJson).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${compactJson(item)}`)
      .join(", ")} }`;
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Cannot serialize a non-JSON value");
  }
  return serialized;
}

function formatJson(value: unknown, level: number, prefixLength = 0): string {
  const compact = compactJson(value);
  if (
    compact.length + level * JSON_INDENT.length + prefixLength <
    JSON_PRINT_WIDTH
  ) {
    return compact;
  }

  if (Array.isArray(value)) {
    const childLevel = level + 1;
    return `[\n${value
      .map(
        (item) =>
          `${JSON_INDENT.repeat(childLevel)}${formatJson(item, childLevel)}`,
      )
      .join(",\n")}\n${JSON_INDENT.repeat(level)}]`;
  }

  if (value !== null && typeof value === "object") {
    const childLevel = level + 1;
    return `{\n${Object.entries(value)
      .map(([key, item]) => {
        const propertyPrefix = `${JSON.stringify(key)}: `;
        return `${JSON_INDENT.repeat(childLevel)}${propertyPrefix}${formatJson(
          item,
          childLevel,
          propertyPrefix.length,
        )}`;
      })
      .join(",\n")}\n${JSON_INDENT.repeat(level)}}`;
  }

  return compact;
}

export const STORAGE_V2_PROVIDER_MATRIX_DOCUMENT = Object.freeze({
  schema: "hot-updater.storage-v2-provider-matrix/v1",
  cells: STORAGE_V2_PROVIDER_MATRIX,
});

export const STORAGE_V2_PROVIDER_MATRIX_FIXTURE = `${formatJson(
  STORAGE_V2_PROVIDER_MATRIX_DOCUMENT,
  0,
)}\n`;
