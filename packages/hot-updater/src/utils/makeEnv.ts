import fs from "fs/promises";

export const makeEnv = async (
  newEnvVars: Record<string, string>,
  filePath = ".env",
): Promise<string> => {
  try {
    // Read the existing .env file or initialize with an empty string
    const existingContent = await fs
      .readFile(filePath, "utf-8")
      .catch(() => "");

    // Parse the existing content while preserving comments and formatting
    const lines = existingContent.split("\n");
    const envVars = new Map<string, string>();
    const updatedLines: string[] = [];

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (!trimmedLine || trimmedLine.startsWith("#")) {
        // Preserve empty lines and comments
        updatedLines.push(line);
      } else {
        const [key, ...rest] = line.split("=");
        const value = rest.join("=");
        if (key) {
          const trimmedKey = key.trim();
          envVars.set(trimmedKey, value?.trim() ?? "");
          // Add the updated variable or preserve existing if not updated
          updatedLines.push(`${trimmedKey}=${newEnvVars[trimmedKey] ?? value}`);
        }
      }
    }

    // Append new variables that don't already exist
    for (const [key, value] of Object.entries(newEnvVars)) {
      if (!envVars.has(key)) {
        updatedLines.push(`${key}=${value}`);
      }
    }

    const updatedContent = updatedLines.join("\n");

    // Write the updated content back to the .env file
    await fs.writeFile(filePath, updatedContent, "utf-8");

    return updatedContent;
  } catch (error) {
    console.error("Error while updating .env file:", error);
    throw error;
  }
};
