import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

const GENERATED_SCHEMA_BASENAME = "hot-updater-schema";

const PLACEHOLDER_CONTENT = [
  "// Temporary placeholder for hot-updater db generate.",
  "// It is removed automatically unless generation overwrites it.",
  "export {};",
  "",
].join("\n");

const getMissingModuleRequest = (error: unknown): string | undefined => {
  if (!(error instanceof Error)) return undefined;
  return error.message.match(/Cannot find module '([^']+)'/)?.[1];
};

const getRequireStack = (error: unknown): readonly string[] => {
  const maybeStack =
    error instanceof Error && "requireStack" in error
      ? error.requireStack
      : undefined;
  if (!Array.isArray(maybeStack)) return [];
  return maybeStack.filter((item): item is string => typeof item === "string");
};

export const resolveGeneratedSchemaPlaceholderPath = (
  error: unknown,
): string | undefined => {
  const request = getMissingModuleRequest(error);
  if (!request?.includes(GENERATED_SCHEMA_BASENAME)) return undefined;
  if (!request.startsWith(".")) return undefined;

  const [importer] = getRequireStack(error);
  if (!importer) return undefined;

  const resolved = path.resolve(path.dirname(importer), request);
  return path.extname(resolved) ? resolved : `${resolved}.ts`;
};

export const createGeneratedSchemaPlaceholder = async (
  filePath: string,
): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, PLACEHOLDER_CONTENT, {
    encoding: "utf-8",
    flag: "wx",
  }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return;
    }
    throw error;
  });
};

export const removeGeneratedSchemaPlaceholder = async (
  filePath: string | undefined,
): Promise<void> => {
  if (!filePath) return;

  const content = await readFile(filePath, "utf-8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (content !== PLACEHOLDER_CONTENT) return;

  await rm(filePath, { force: true });
};
