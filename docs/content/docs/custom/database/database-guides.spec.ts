import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  generateDatabaseGuideSchema,
  typecheckDatabaseGuideConsumer,
  validatePrismaGuideSchema,
} from "./database-guide-consumer";

const readGuide = (name: "drizzle" | "kysely" | "prisma") =>
  readFile(new URL(`./${name}.mdx`, import.meta.url), "utf8");

const readCustomGuide = () =>
  readFile(
    new URL("../../database-plugins/custom-database.mdx", import.meta.url),
    "utf8",
  );

const extractCodeBlock = (
  guide: string,
  language: "prisma" | "typescript",
  title?: string,
) => {
  const info = title ? `${language} title="${title}"` : language;
  const marker = `\`\`\`${info}\n`;
  const start = guide.indexOf(marker);
  if (start < 0) return "";
  const contentStart = start + marker.length;
  const end = guide.indexOf("\n```", contentStart);
  return end < 0 ? "" : guide.slice(contentStart, end);
};

const extractRequiredCodeBlock = (
  guide: string,
  language: "prisma" | "typescript",
  title?: string,
): string => {
  const block = extractCodeBlock(guide, language, title);
  if (!block) {
    throw new TypeError(`Missing ${title ?? language} code block.`);
  }
  return block;
};

const extractUntitledCodeBlocks = (
  guide: string,
  language: "typescript",
): readonly string[] => {
  const marker = `\`\`\`${language}\n`;
  const blocks: string[] = [];
  let searchFrom = 0;
  while (searchFrom < guide.length) {
    const start = guide.indexOf(marker, searchFrom);
    if (start < 0) return blocks;
    const contentStart = start + marker.length;
    const end = guide.indexOf("\n```", contentStart);
    if (end < 0) throw new TypeError(`Unclosed ${language} code block.`);
    blocks.push(guide.slice(contentStart, end));
    searchFrom = end + 4;
  }
  return blocks;
};

const requiredItem = (
  items: readonly string[],
  index: number,
  label: string,
): string => {
  const item = items[index];
  if (!item) throw new TypeError(`Missing ${label} code block.`);
  return item;
};

const extractPrismaAdapterModels = (schema: string): string => {
  const begin = "// --- BEGIN HOT-UPDATER MODELS (DO NOT EDIT) ---";
  const end = "// --- END HOT-UPDATER MODELS ---";
  const start = schema.indexOf(begin);
  const finish = schema.indexOf(end);
  if (start < 0 || finish < 0 || finish <= start) {
    throw new TypeError("Missing Hot Updater Prisma model markers.");
  }
  return schema.slice(start + begin.length, finish).trim();
};

const normalizeContract = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

describe("database middle-layer guides", () => {
  it("type-checks Kysely, Drizzle, and custom provider consumers", async () => {
    // Given
    const [kysely, drizzle, custom] = await Promise.all([
      readGuide("kysely"),
      readGuide("drizzle"),
      readCustomGuide(),
    ]);
    const customConfigs = extractUntitledCodeBlocks(custom, "typescript");

    // When
    const typecheck = typecheckDatabaseGuideConsumer({
      customCliConfig: requiredItem(customConfigs, 0, "custom CLI config"),
      customProvider: extractRequiredCodeBlock(
        custom,
        "typescript",
        "src/customKyselyDatabase.ts",
      ),
      customServerConfig: requiredItem(
        customConfigs,
        1,
        "custom server config",
      ),
      drizzleCliConfig: extractRequiredCodeBlock(
        drizzle,
        "typescript",
        "hot-updater.config.ts",
      ),
      drizzleConfig: extractRequiredCodeBlock(
        drizzle,
        "typescript",
        "drizzle.config.ts",
      ),
      drizzleHotUpdater: extractRequiredCodeBlock(
        drizzle,
        "typescript",
        "src/hotUpdater.ts",
      ),
      drizzleSetup: extractRequiredCodeBlock(
        drizzle,
        "typescript",
        "src/drizzle.ts",
      ),
      kyselyCliConfig: extractRequiredCodeBlock(
        kysely,
        "typescript",
        "hot-updater.config.ts",
      ),
      kyselyHotUpdater: extractRequiredCodeBlock(
        kysely,
        "typescript",
        "src/hotUpdater.ts",
      ),
      kyselySetup: extractRequiredCodeBlock(
        kysely,
        "typescript",
        "src/kysely.ts",
      ),
    });

    // Then
    await expect(typecheck).resolves.toBeUndefined();
  });

  it("validates the Prisma guide against the generated adapter contract", async () => {
    // Given
    const guide = await readGuide("prisma");
    const schema = extractRequiredCodeBlock(guide, "prisma");

    // When
    const documentedModels = extractPrismaAdapterModels(schema);
    const generatedModels = await generateDatabaseGuideSchema(
      "generatePrismaSchema",
    );

    // Then
    expect(normalizeContract(documentedModels)).toBe(
      normalizeContract(generatedModels),
    );
    await expect(validatePrismaGuideSchema(schema)).resolves.toBeUndefined();
  });
});
