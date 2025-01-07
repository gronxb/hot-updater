import path from "path";
import dayjs from "dayjs";
import fs from "fs/promises";
import pc from "picocolors";

/**
 * Find markers in the format '-- HotUpdater.xxxx' from content and
 * extract SQL statements from each marker to the next marker into a Map
 * @param {string} content - SQL file content
 * @returns {Map<string, string>} - key is HotUpdater marker, value is the block
 */
function parseHotUpdaterContents(content: string) {
  const markerRegex = /--\s*HotUpdater\.[^\n]*/g;
  const resultMap = new Map();

  // Extract HotUpdater markers
  const markers = content.match(markerRegex);
  if (!markers) return resultMap;

  // Find blocks for each marker and store in Map
  for (const marker of markers) {
    const key = marker.trim();
    // Regex: Extract statement from marker(key) to next HotUpdater marker
    const blockRegex = new RegExp(`${key}[\\s\\S]*?(?=--\\s*HotUpdater\\.|$)`);
    const matchBlock = content.match(blockRegex);
    if (matchBlock) {
      resultMap.set(key, matchBlock[0].trim());
    }
  }

  return resultMap;
}

/**
 * Read all .sql files from a directory, extract HotUpdater blocks
 * and combine them into a single Map
 * @param {string} dirPath - Migration directory path
 * @returns {Promise<Map<string, string>>} - key: HotUpdater marker, value: block
 */
async function readHotUpdaterBlocksFromDir(dirPath: string) {
  const files = (await fs.readdir(dirPath)).sort((a, b) => a.localeCompare(b));
  const migrationMap = new Map();

  for (const file of files) {
    if (!file.endsWith(".sql")) continue;

    const filePath = path.join(dirPath, file);
    const content = await fs.readFile(filePath, "utf-8");
    // Extract HotUpdater blocks from file content
    const parsedBlocks = parseHotUpdaterContents(content);

    // Store all extracted blocks in Map
    for (const [key, block] of parsedBlocks.entries()) {
      migrationMap.set(key, block);
    }
  }

  return migrationMap;
}

/**
 * Extract HotUpdater blocks from new SQL files (@hot-updater/postgres/sql) into a Map
 * @param {string} dirPath - @hot-updater/postgres/sql directory path
 * @returns {Promise<Map<string, string>>}
 */
async function readNewMigrations(dirPath: string) {
  const files = await fs.readdir(dirPath);
  const newMigrationMap = new Map();

  // Select .sql files and extract HotUpdater blocks
  for (const file of files) {
    if (!file.endsWith(".sql")) continue;

    const filePath = path.join(dirPath, file);
    const content = await fs.readFile(filePath, "utf-8");
    const parsedBlocks = parseHotUpdaterContents(content);

    for (const [key, block] of parsedBlocks.entries()) {
      newMigrationMap.set(key, block);
    }
  }

  return newMigrationMap;
}

/**
 * Main function responsible for actual migration file creation
 */
async function main() {
  // @hot-updater/postgres/sql path
  const postgresPath = import.meta
    .resolve("@hot-updater/postgres/sql")
    .replace("file://", "");

  // Create migrations directory (skip if exists)
  const migrationsDir = path.join(process.cwd(), "supabase/migrations");
  await fs.mkdir(migrationsDir, { recursive: true });

  // Extract all HotUpdater blocks from existing migration .sql files
  const existingMigrations = await readHotUpdaterBlocksFromDir(migrationsDir);
  console.log(
    pc.blue("Existing migration contents:"),
    Array.from(existingMigrations.keys()),
  );

  // Extract all HotUpdater blocks from new SQL files
  const newMigrations = await readNewMigrations(postgresPath);
  console.log(
    pc.blue("New migration contents:"),
    Array.from(newMigrations.keys()),
  );

  // Collect blocks that differ from existing ones
  const changedBlocks: string[] = [];
  for (const [key, block] of newMigrations.entries()) {
    const existingBlock = existingMigrations.get(key);
    if (existingBlock !== block) {
      changedBlocks.push(block);
    }
  }

  // Create new migration file if there are changed blocks
  if (changedBlocks.length > 0) {
    const combinedSql = changedBlocks.join("\n\n");
    const newFileName = `${dayjs().format("YYYYMMDDHHmmss")}.sql`;

    await fs.writeFile(path.join(migrationsDir, newFileName), combinedSql);
    console.log(pc.green("New migration file created:"), pc.bold(newFileName));
  } else {
    console.log(
      pc.yellow("No changes detected. No new migration file created."),
    );
  }
}

// Execute main function
main().catch((err) => {
  console.error(pc.red("Error during migration creation:"), err);
  process.exit(1);
});
