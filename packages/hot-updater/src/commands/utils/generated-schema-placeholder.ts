import { realpathSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

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

const resolveExistingDirectory = (directory: string): string => {
  try {
    return realpathSync.native(directory);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error) {
      return path.resolve(directory);
    }
    throw error;
  }
};

export const resolveGeneratedSchemaPlaceholderPath = (
  error: unknown,
  cwd = process.cwd(),
): string | undefined => {
  const request = getMissingModuleRequest(error);
  if (!request) return undefined;
  if (!request.startsWith(".") && !path.isAbsolute(request)) {
    return undefined;
  }

  const [importer] = getRequireStack(error);
  if (!importer) return undefined;

  const extension = path.extname(request);
  if (extension && extension !== ".ts") return undefined;

  const resolved = path.isAbsolute(request)
    ? request
    : path.resolve(path.dirname(importer), request);
  const placeholderPath = extension
    ? resolved
    : `${resolved}.ts`;
  const projectRoot = resolveExistingDirectory(cwd);
  const placeholderDirectory = resolveExistingDirectory(
    path.dirname(placeholderPath),
  );
  const normalizedPlaceholderPath = path.join(
    placeholderDirectory,
    path.basename(placeholderPath),
  );
  const relativeToCwd = path.relative(projectRoot, normalizedPlaceholderPath);
  if (relativeToCwd.startsWith("..") || path.isAbsolute(relativeToCwd)) {
    return undefined;
  }

  return normalizedPlaceholderPath;
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
