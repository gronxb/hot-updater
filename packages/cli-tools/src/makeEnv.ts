import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type EnvVarValue = string | { comment: string; value: string };

const isFileSystemError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const assertSafeExistingTarget = async (filePath: string) => {
  try {
    const target = await fs.lstat(filePath);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new Error(
        `Refusing to write init environment values to a non-regular file: ${filePath}`,
      );
    }
  } catch (error) {
    if (isFileSystemError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
};

const serializeEnvValue = (value: string) => {
  if (
    value.includes("\u0000") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new Error("Environment values cannot contain NUL or newlines.");
  }
  return /^[A-Za-z0-9_./:@%+,=-]*$/.test(value) ? value : JSON.stringify(value);
};

const formatEnvLine = (key: string, value: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`);
  }
  return `${key}=${serializeEnvValue(value)}`;
};

const formatComment = (comment: string) => {
  if (
    comment.includes("\u0000") ||
    comment.includes("\r") ||
    comment.includes("\n")
  ) {
    throw new Error("Environment comments cannot contain NUL or newlines.");
  }
  return `# ${comment}`;
};

const writeEnvAtomically = async (filePath: string, content: string) => {
  const resolvedPath = path.resolve(filePath);
  const temporaryPath = path.join(
    path.dirname(resolvedPath),
    `.${path.basename(resolvedPath)}.${randomUUID()}.tmp`,
  );
  let renamed = false;
  try {
    await fs.writeFile(temporaryPath, content, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, resolvedPath);
    renamed = true;
  } finally {
    if (!renamed) {
      await fs.rm(temporaryPath, { force: true });
    }
  }
};

export const makeEnv = async (
  newEnvVars: Record<string, EnvVarValue>,
  filePath = ".env.hotupdater",
  options?: {
    readonly preserveKeys?: readonly string[];
    readonly removeKeys?: readonly string[];
  },
): Promise<string> => {
  try {
    const resolvedFilePath = path.resolve(filePath);
    await assertSafeExistingTarget(resolvedFilePath);
    const preserveKeys = new Set(options?.preserveKeys ?? []);
    const removeKeys = new Set(options?.removeKeys ?? []);
    const existingContent = await fs
      .readFile(resolvedFilePath, "utf-8")
      .catch((error) => {
        if (isFileSystemError(error) && error.code === "ENOENT") {
          return "";
        }
        throw error;
      });
    const lines = existingContent ? existingContent.split("\n") : [];
    const processedKeys = new Set<string>();
    const updatedLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmedLine = line.trim();

      // Handle empty lines: preserve them as-is.
      if (trimmedLine === "") {
        updatedLines.push(line);
        continue;
      }

      // Handle comment lines
      if (trimmedLine.startsWith("#")) {
        if (i + 1 < lines.length) {
          const nextLine = (lines[i + 1] ?? "").trim();
          if (nextLine && !nextLine.startsWith("#") && nextLine.includes("=")) {
            const [possibleKey = ""] = nextLine.split("=");
            if (removeKeys.has(possibleKey.trim())) {
              continue;
            }
            if (
              Object.hasOwn(newEnvVars, possibleKey.trim()) &&
              !preserveKeys.has(possibleKey.trim())
            ) {
              // Skip the current comment line if the following key is being updated
              continue;
            }
          }
        }
        updatedLines.push(line);
        continue;
      }

      // Process lines in key=value format
      if (trimmedLine.includes("=")) {
        const [keyPart] = line.split("=");
        const key = keyPart?.trim() ?? "";
        if (removeKeys.has(key)) {
          continue;
        }
        if (Object.hasOwn(newEnvVars, key)) {
          processedKeys.add(key);
          if (preserveKeys.has(key)) {
            updatedLines.push(line);
            continue;
          }

          const newValue = newEnvVars[key];
          if (typeof newValue === "object" && newValue !== null) {
            updatedLines.push(formatComment(newValue.comment));
            updatedLines.push(formatEnvLine(key, newValue.value));
          } else {
            updatedLines.push(formatEnvLine(key, newValue));
          }
        } else {
          updatedLines.push(line);
        }
      } else {
        updatedLines.push(line);
      }
    }

    // Append new variables that do not exist in the file
    for (const [key, val] of Object.entries(newEnvVars)) {
      if (!processedKeys.has(key)) {
        if (typeof val === "object" && val !== null) {
          updatedLines.push(formatComment(val.comment));
          updatedLines.push(formatEnvLine(key, val.value));
        } else {
          updatedLines.push(formatEnvLine(key, val));
        }
      }
    }

    const updatedContent = updatedLines.join("\n");
    await writeEnvAtomically(resolvedFilePath, updatedContent);
    return updatedContent;
  } catch (error) {
    console.error("Error while updating .env.hotupdater file:", error);
    throw error;
  }
};
