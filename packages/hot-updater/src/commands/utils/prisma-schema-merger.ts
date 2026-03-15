const HOT_UPDATER_BEGIN_MARKER =
  "// --- BEGIN HOT-UPDATER MODELS (DO NOT EDIT) ---";
const HOT_UPDATER_END_MARKER = "// --- END HOT-UPDATER MODELS ---";

export interface MergeResult {
  content: string;
  hadExistingModels: boolean;
}

/**
 * Extracts only model definitions from a Prisma schema,
 * removing generator and datasource blocks.
 */
function extractModels(schemaContent: string): string {
  const lines = schemaContent.split("\n");
  const modelLines: string[] = [];
  let insideModel = false;
  let braceCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip generator and datasource blocks
    if (trimmed.startsWith("generator ") || trimmed.startsWith("datasource ")) {
      insideModel = false;
      braceCount = 0;
      continue;
    }

    // Start of a model
    if (trimmed.startsWith("model ") || trimmed.startsWith("enum ")) {
      insideModel = true;
      braceCount = 0;
    }

    // Count braces to track when we're inside a block
    if (insideModel) {
      for (const char of line) {
        if (char === "{") braceCount++;
        if (char === "}") braceCount--;
      }

      modelLines.push(line);

      // End of model block
      if (braceCount === 0 && trimmed.endsWith("}")) {
        insideModel = false;
      }
    }
  }

  return modelLines.join("\n").trim();
}

/**
 * Detects hot-updater models in schema (even without markers)
 * by looking for known hot-updater model names.
 */
function findHotUpdaterModels(lines: string[]): {
  startIndex: number;
  endIndex: number;
} | null {
  const hotUpdaterModelNames = ["bundles", "private_hot_updater_settings"];
  let firstModelIndex = -1;
  let lastModelIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() || "";

    // Check if this line starts a hot-updater model
    for (const modelName of hotUpdaterModelNames) {
      if (trimmed === `model ${modelName} {`) {
        if (firstModelIndex === -1) {
          firstModelIndex = i;
        }

        // Find the end of this model
        let braceCount = 0;
        for (let j = i; j < lines.length; j++) {
          for (const char of lines[j] || "") {
            if (char === "{") braceCount++;
            if (char === "}") braceCount--;
          }
          if (braceCount === 0 && (lines[j]?.trim() || "").endsWith("}")) {
            lastModelIndex = j;
            break;
          }
        }
      }
    }
  }

  if (firstModelIndex !== -1 && lastModelIndex !== -1) {
    return { startIndex: firstModelIndex, endIndex: lastModelIndex };
  }
  return null;
}

/**
 * Merges hot-updater models into an existing Prisma schema file.
 * Preserves user-defined models, generators, and datasources.
 */
export function mergePrismaSchema(
  existingSchema: string,
  hotUpdaterModels: string,
): MergeResult {
  // Extract only models from hotUpdaterModels (in case it contains generator/datasource)
  const modelsOnly = extractModels(hotUpdaterModels);

  const lines = existingSchema.split("\n");
  let beginIndex = -1;
  let endIndex = -1;

  // First, try to find existing hot-updater section by markers
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.includes(HOT_UPDATER_BEGIN_MARKER)) {
      beginIndex = i;
    }
    if (lines[i]?.includes(HOT_UPDATER_END_MARKER)) {
      endIndex = i;
      break;
    }
  }

  let hadExistingModels = beginIndex !== -1 && endIndex !== -1;

  // If markers not found, try to find hot-updater models by name
  if (!hadExistingModels) {
    const detected = findHotUpdaterModels(lines);
    if (detected) {
      beginIndex = detected.startIndex;
      endIndex = detected.endIndex;
      hadExistingModels = true;
    }
  }

  // Remove existing hot-updater section if found
  if (hadExistingModels) {
    // Also remove leading empty lines before the marker (up to 2)
    let startRemoveIndex = beginIndex;
    for (let i = beginIndex - 1; i >= Math.max(0, beginIndex - 2); i--) {
      if (lines[i]?.trim() === "") {
        startRemoveIndex = i;
      } else {
        break;
      }
    }

    // Also remove trailing empty line after the marker (1 line)
    let endRemoveIndex = endIndex;
    if (endIndex + 1 < lines.length && lines[endIndex + 1]?.trim() === "") {
      endRemoveIndex = endIndex + 1;
    }

    lines.splice(startRemoveIndex, endRemoveIndex - startRemoveIndex + 1);
  }

  // Prepare hot-updater section
  const hotUpdaterSection = [
    "",
    HOT_UPDATER_BEGIN_MARKER,
    modelsOnly,
    HOT_UPDATER_END_MARKER,
    "",
  ];

  // Append hot-updater models at the end
  const mergedLines = [...lines, ...hotUpdaterSection];

  return {
    content: mergedLines.join("\n"),
    hadExistingModels,
  };
}
