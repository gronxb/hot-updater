import fs from "fs/promises";

type EnvVarValue = string | { comment: string; value: string };

export const makeEnv = async (
  newEnvVars: Record<string, EnvVarValue>,
  filePath = ".env",
): Promise<string> => {
  try {
    // Read the existing .env file or initialize with an empty string if not found
    const existingContent = await fs
      .readFile(filePath, "utf-8")
      .catch(() => "");
    // If file is empty, use an empty array to avoid an initial empty line.
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
            if (
              Object.prototype.hasOwnProperty.call(
                newEnvVars,
                possibleKey.trim(),
              )
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
        if (Object.prototype.hasOwnProperty.call(newEnvVars, key)) {
          processedKeys.add(key);
          const newValue = newEnvVars[key];
          if (typeof newValue === "object" && newValue !== null) {
            updatedLines.push(`# ${newValue.comment}`);
            updatedLines.push(`${key}=${newValue.value}`);
          } else {
            updatedLines.push(`${key}=${newValue}`);
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
          updatedLines.push(`# ${val.comment}`);
          updatedLines.push(`${key}=${val.value}`);
        } else {
          updatedLines.push(`${key}=${val}`);
        }
      }
    }

    const updatedContent = updatedLines.join("\n");
    await fs.writeFile(filePath, updatedContent, "utf-8");
    return updatedContent;
  } catch (error) {
    console.error("Error while updating .env file:", error);
    throw error;
  }
};
