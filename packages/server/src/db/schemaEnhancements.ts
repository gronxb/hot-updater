import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  INVALID_COHORT_ERROR_MESSAGE,
  isValidCohort,
  type Bundle,
} from "@hot-updater/core";
import semver from "semver";

type AdapterName = "drizzle" | "prisma" | string;
type KyselyProvider = "postgresql" | "mysql" | "sqlite";

type MigrationResultLike = {
  execute: () => Promise<void>;
  getSQL?: () => string;
  operations: Array<Record<string, unknown>>;
};

type SchemaVersionLike = {
  version: string;
};

type MigratorLike = {
  down: (options?: unknown) => Promise<MigrationResultLike>;
  getNameVariants: () => Promise<unknown>;
  getVersion: () => Promise<string | undefined>;
  migrateTo: (
    version: string,
    options?: unknown,
  ) => Promise<MigrationResultLike>;
  migrateToLatest: (options?: unknown) => Promise<MigrationResultLike>;
  next: () => Promise<SchemaVersionLike | undefined>;
  previous: () => Promise<SchemaVersionLike | undefined>;
  up: (options?: unknown) => Promise<MigrationResultLike>;
};

const normalizeNullableString = (value: string | null | undefined) => {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const appendPrismaModelLines = (
  code: string,
  modelName: string,
  lines: string[],
  options?: {
    position?: "beforeAttributes" | "end";
  },
) => {
  const pattern = new RegExp(
    `model ${modelName} \\{\\n([\\s\\S]*?)\\n\\}`,
    "m",
  );
  return code.replace(pattern, (full, body: string) => {
    const bodyLines = body.split("\n");
    const existingLines = new Set(
      bodyLines.map((line) => line.trim()).filter(Boolean),
    );
    const additions = lines
      .filter((line) => !existingLines.has(line))
      .map((line) => `  ${line}`);

    if (additions.length === 0) {
      return full;
    }

    if (options?.position === "beforeAttributes") {
      const insertIndex = bodyLines.findIndex((line) =>
        line.trim().startsWith("@@"),
      );
      if (insertIndex === -1) {
        bodyLines.push(...additions);
      } else {
        bodyLines.splice(insertIndex, 0, ...additions);
      }

      return `model ${modelName} {\n${bodyLines.join("\n")}\n}`;
    }

    return `model ${modelName} {\n${body}\n${additions.join("\n")}\n}`;
  });
};

const ensureDrizzleIndexImport = (code: string) =>
  code.replace(
    /import \{ ([^}]+) \} from "(drizzle-orm\/[^"]+-core)"/,
    (_full, imports: string, modulePath: string) => {
      const values = imports
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

      if (!values.includes("index")) {
        values.push("index");
      }

      return `import { ${values.join(", ")} } from "${modulePath}"`;
    },
  );

const ensureDrizzleMetadataDefault = (code: string) =>
  code
    .replace(
      /metadata: json\("metadata"\)\.notNull\(\)(?!\.default\(\{\}\))/,
      'metadata: json("metadata").notNull().default({})',
    )
    .replace(
      /metadata: blob\("metadata", \{ mode: "json" \}\)\.notNull\(\)(?!\.default\(\{\}\))/,
      'metadata: blob("metadata", { mode: "json" }).notNull().default({})',
    );

const removeUnusedDrizzleRelationMany = (code: string) =>
  code.replace(
    /export const bundle_patchesRelations = relations\(bundle_patches, \(\{ one, many \}\) => \(\{/,
    "export const bundle_patchesRelations = relations(bundle_patches, ({ one }) => ({",
  );

const ensureTrailingComma = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.endsWith(",") || trimmed.endsWith("[")) {
    return line;
  }

  return `${line},`;
};

const updateDrizzleTableBlock = (
  code: string,
  tableName: string,
  callbackLines: string[],
) => {
  const blockStart = code.indexOf(`export const ${tableName} = `);
  if (blockStart === -1) {
    return code;
  }

  const nextBlockStart = code.indexOf("\n\nexport const ", blockStart + 1);
  const blockEnd = nextBlockStart === -1 ? code.length : nextBlockStart;
  const block = code.slice(blockStart, blockEnd);

  if (block.includes(", (table) => [")) {
    const callbackPattern = /, \(table\) => \[\n([\s\S]*?)\n\]\)\s*$/;
    const match = block.match(callbackPattern);

    if (!match) {
      return code;
    }

    const callbackBody = match[1] ?? "";
    const existingLines = callbackBody
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const additions = callbackLines.filter(
      (line) => !existingLines.includes(line),
    );

    if (additions.length === 0) {
      return code;
    }

    const callbackBodyLines = callbackBody.split("\n");
    for (let index = callbackBodyLines.length - 1; index >= 0; index -= 1) {
      if (callbackBodyLines[index]?.trim()) {
        callbackBodyLines[index] = ensureTrailingComma(
          callbackBodyLines[index]!,
        );
        break;
      }
    }

    const nextCallbackBody = [
      ...callbackBodyLines,
      ...additions.map((line) => `  ${line}`),
    ].join("\n");
    const nextBlock = block.replace(
      callbackPattern,
      `, (table) => [\n${nextCallbackBody}\n])`,
    );

    return `${code.slice(0, blockStart)}${nextBlock}${code.slice(blockEnd)}`;
  }

  const callbackBody = callbackLines.map((line) => `  ${line}`).join("\n");
  const nextBlock = block.replace(
    /\n\}\)\s*$/,
    `\n}, (table) => [\n${callbackBody}\n])`,
  );

  return `${code.slice(0, blockStart)}${nextBlock}${code.slice(blockEnd)}`;
};

const addCustomSqlOperation = (
  result: MigrationResultLike,
  sql: string,
): void => {
  const normalizedSql = sql.trim();
  const alreadyAdded = result.operations.some((operation) => {
    return (
      operation["type"] === "custom" &&
      typeof operation["sql"] === "string" &&
      operation["sql"].trim() === normalizedSql
    );
  });

  if (!alreadyAdded) {
    result.operations.push({
      type: "custom",
      sql: normalizedSql,
    });
  }
};

const getMigrationCustomSql = (
  provider: KyselyProvider,
  targetVersion: string,
): string[] => {
  const statements: string[] = [];
  const hasRolloutColumns = semver.gte(targetVersion, "0.29.0");
  const hasPatchTable = semver.gte(targetVersion, "0.31.0");

  if (provider === "postgresql") {
    statements.push(
      "create index bundles_target_app_version_idx on bundles(target_app_version)",
      "create index bundles_fingerprint_hash_idx on bundles(fingerprint_hash)",
      "create index bundles_channel_idx on bundles(channel)",
      "alter table bundles add constraint check_version_or_fingerprint check ((target_app_version is not null) or (fingerprint_hash is not null))",
    );

    if (hasRolloutColumns) {
      statements.push(
        "create index bundles_rollout_idx on bundles(rollout_cohort_count)",
        "alter table bundles add constraint bundles_rollout_cohort_count_check check (rollout_cohort_count >= 0 and rollout_cohort_count <= 1000)",
      );
    }

    if (hasPatchTable) {
      statements.push(
        "create index bundle_patches_bundle_id_idx on bundle_patches(bundle_id)",
        "create index bundle_patches_base_bundle_id_idx on bundle_patches(base_bundle_id)",
      );
    }

    return statements;
  }

  if (provider === "mysql") {
    statements.push(
      "create index bundles_target_app_version_idx on bundles(target_app_version(255))",
      "create index bundles_fingerprint_hash_idx on bundles(fingerprint_hash(255))",
      "create index bundles_channel_idx on bundles(channel(255))",
      "alter table bundles add constraint check_version_or_fingerprint check ((target_app_version is not null) or (fingerprint_hash is not null))",
    );

    if (hasRolloutColumns) {
      statements.push(
        "create index bundles_rollout_idx on bundles(rollout_cohort_count)",
        "alter table bundles add constraint bundles_rollout_cohort_count_check check (rollout_cohort_count >= 0 and rollout_cohort_count <= 1000)",
      );
    }

    if (hasPatchTable) {
      statements.push(
        "create index bundle_patches_bundle_id_idx on bundle_patches(bundle_id)",
        "create index bundle_patches_base_bundle_id_idx on bundle_patches(base_bundle_id)",
      );
    }

    return statements;
  }

  statements.push(
    "create index bundles_target_app_version_idx on bundles(target_app_version)",
    "create index bundles_fingerprint_hash_idx on bundles(fingerprint_hash)",
    "create index bundles_channel_idx on bundles(channel)",
  );

  if (hasRolloutColumns) {
    statements.push(
      "create index bundles_rollout_idx on bundles(rollout_cohort_count)",
    );
  }

  if (hasPatchTable) {
    statements.push(
      "create index bundle_patches_bundle_id_idx on bundle_patches(bundle_id)",
      "create index bundle_patches_base_bundle_id_idx on bundle_patches(base_bundle_id)",
    );
  }

  return statements;
};

const enhanceUpwardMigrationResult = (
  result: MigrationResultLike,
  provider: KyselyProvider,
  targetVersion: string,
) => {
  for (const sql of getMigrationCustomSql(provider, targetVersion)) {
    addCustomSqlOperation(result, sql);
  }

  return result;
};

export const assertBundlePersistenceConstraints = (
  bundle: Pick<
    Bundle,
    | "fingerprintHash"
    | "rolloutCohortCount"
    | "targetAppVersion"
    | "targetCohorts"
  >,
) => {
  const targetAppVersion = normalizeNullableString(bundle.targetAppVersion);
  const fingerprintHash = normalizeNullableString(bundle.fingerprintHash);

  if (!targetAppVersion && !fingerprintHash) {
    throw new Error(
      "Bundle must define either targetAppVersion or fingerprintHash.",
    );
  }

  const rolloutCohortCount = bundle.rolloutCohortCount;
  if (rolloutCohortCount !== null && rolloutCohortCount !== undefined) {
    if (
      !Number.isInteger(rolloutCohortCount) ||
      rolloutCohortCount < 0 ||
      rolloutCohortCount > DEFAULT_ROLLOUT_COHORT_COUNT
    ) {
      throw new Error(
        `rolloutCohortCount must be an integer between 0 and ${DEFAULT_ROLLOUT_COHORT_COUNT}.`,
      );
    }
  }

  for (const cohort of bundle.targetCohorts ?? []) {
    if (!isValidCohort(cohort)) {
      throw new Error(
        `Invalid target cohort "${cohort}". ${INVALID_COHORT_ERROR_MESSAGE}`,
      );
    }
  }
};

export const enhanceGeneratedSchema = (
  adapterName: AdapterName,
  code: string,
) => {
  if (adapterName === "prisma") {
    let nextCode = code.replace(
      /^(\s*metadata\s+Json)(?!\s+@default\("?\{\}"?\))(.*)$/m,
      '$1 @default("{}")$2',
    );
    nextCode = appendPrismaModelLines(
      nextCode,
      "bundles",
      [
        'patches bundle_patches[] @relation("bundle_patches_bundles_patches")',
        'baseForPatches bundle_patches[] @relation("bundle_patches_bundles_baseForPatches")',
      ],
      {
        position: "beforeAttributes",
      },
    );
    nextCode = appendPrismaModelLines(nextCode, "bundles", [
      '@@index([target_app_version], map: "bundles_target_app_version_idx")',
      '@@index([fingerprint_hash], map: "bundles_fingerprint_hash_idx")',
      '@@index([channel], map: "bundles_channel_idx")',
      '@@index([rollout_cohort_count], map: "bundles_rollout_idx")',
    ]);
    return appendPrismaModelLines(nextCode, "bundle_patches", [
      '@@index([bundle_id], map: "bundle_patches_bundle_id_idx")',
      '@@index([base_bundle_id], map: "bundle_patches_base_bundle_id_idx")',
    ]);
  }

  if (adapterName === "drizzle") {
    let nextCode = ensureDrizzleMetadataDefault(code);
    nextCode = removeUnusedDrizzleRelationMany(nextCode);
    nextCode = ensureDrizzleIndexImport(nextCode);
    nextCode = updateDrizzleTableBlock(nextCode, "bundles", [
      'index("bundles_target_app_version_idx").on(table.target_app_version),',
      'index("bundles_fingerprint_hash_idx").on(table.fingerprint_hash),',
      'index("bundles_channel_idx").on(table.channel),',
      'index("bundles_rollout_idx").on(table.rollout_cohort_count),',
    ]);
    nextCode = updateDrizzleTableBlock(nextCode, "bundle_patches", [
      'index("bundle_patches_bundle_id_idx").on(table.bundle_id),',
      'index("bundle_patches_base_bundle_id_idx").on(table.base_bundle_id),',
    ]);
    return nextCode;
  }

  return code;
};

export const wrapKyselyMigrator = (
  migrator: MigratorLike,
  provider: KyselyProvider | undefined,
  latestVersion: string,
): MigratorLike => {
  if (!provider) {
    return migrator;
  }

  return {
    ...migrator,
    async up(options?: unknown) {
      const next = await migrator.next();
      const result = await migrator.up(options);

      if (next) {
        enhanceUpwardMigrationResult(result, provider, next.version);
      }

      return result;
    },
    async migrateTo(version: string, options?: unknown) {
      const currentVersion = await migrator.getVersion();
      const result = await migrator.migrateTo(version, options);

      if (!currentVersion || semver.gt(version, currentVersion)) {
        enhanceUpwardMigrationResult(result, provider, version);
      }

      return result;
    },
    async migrateToLatest(options?: unknown) {
      const currentVersion = await migrator.getVersion();
      const result = await migrator.migrateToLatest(options);

      if (!currentVersion || semver.gt(latestVersion, currentVersion)) {
        enhanceUpwardMigrationResult(result, provider, latestVersion);
      }

      return result;
    },
  };
};
