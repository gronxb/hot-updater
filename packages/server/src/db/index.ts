import {
  type UniversalComponentArtifact,
  type UniversalComponentMigrationResult,
  getUniversalComponentLatestSchema,
} from "@hot-updater/plugin-core";

import {
  getHotUpdaterCoreMetadata,
  type RuntimeHotUpdaterAPI,
} from "../createHotUpdaterCore";
export { requireUniversalComponentDataSource } from "../createHotUpdaterCore";
import { generateSchemaFromHotUpdaterSchema } from "./schemaGenerators";
import { type Migrator, type SchemaGenerator } from "./types";

export * from "./createBundleDiff";
export type { Migrator, SchemaGenerator } from "./types";
export { HotUpdaterSchemaMigrationRequiredError } from "./schemaReadiness";
export { HOT_UPDATER_SERVER_VERSION } from "../version";

export type HotUpdaterDBTarget = {
  readonly adapterName: string;
};

export type UniversalComponentMigrationSummary =
  UniversalComponentMigrationResult & {
    readonly componentId: string;
  };

export type UniversalComponentGeneratedArtifact = UniversalComponentArtifact & {
  readonly componentId: string;
};

export class UniversalComponentMigrationUnsupportedError extends Error {
  readonly name = "UniversalComponentMigrationUnsupportedError";

  constructor(
    readonly adapterName: string,
    readonly componentIds: readonly string[],
  ) {
    super(
      `${adapterName} does not support runtime migration for universal components: ${componentIds.join(", ")}.`,
    );
  }
}

const getDBMetadata = (hotUpdater: HotUpdaterDBTarget) => {
  const metadata = getHotUpdaterCoreMetadata(
    hotUpdater as RuntimeHotUpdaterAPI,
  );
  if (!metadata) {
    throw new Error(
      "Database tooling requires a hotUpdater instance created by @hot-updater/server.",
    );
  }
  return metadata;
};

export function createMigrator(hotUpdater: HotUpdaterDBTarget): Migrator {
  const { adapterCapabilities, core } = getDBMetadata(hotUpdater);
  return (adapterCapabilities.createMigrator ?? core.createMigrator)();
}

export function generateSchema(
  hotUpdater: HotUpdaterDBTarget,
  ...args: Parameters<SchemaGenerator>
): ReturnType<SchemaGenerator> {
  const { adapterCapabilities, core } = getDBMetadata(hotUpdater);
  const schemaGenerator =
    adapterCapabilities.generateSchema ?? core.generateSchema;
  return generateSchemaFromHotUpdaterSchema(
    hotUpdater.adapterName,
    adapterCapabilities.provider,
    args[0],
    schemaGenerator(...args),
  );
}

export async function migrateUniversalComponents(
  hotUpdater: HotUpdaterDBTarget,
): Promise<readonly UniversalComponentMigrationSummary[]> {
  const metadata = getDBMetadata(hotUpdater);
  const schemas = metadata.components?.schemas ?? [];
  if (schemas.length === 0) return [];
  const adapter = metadata.universalComponentDataAdapter;
  if (adapter?.migrate === undefined) {
    throw new UniversalComponentMigrationUnsupportedError(
      hotUpdater.adapterName,
      schemas.map(({ id }) => id),
    );
  }
  const results: UniversalComponentMigrationSummary[] = [];
  for (const schema of schemas) {
    const result = await adapter.migrate(schema);
    const expectedVersion = getUniversalComponentLatestSchema(schema).version;
    if (
      typeof result !== "object" ||
      result === null ||
      typeof result.changed !== "boolean" ||
      result.version !== expectedVersion
    ) {
      throw new TypeError(
        `Invalid universal component migration result for ${schema.id}.`,
      );
    }
    results.push(
      Object.freeze({
        changed: result.changed,
        componentId: schema.id,
        version: result.version,
      }),
    );
  }
  return Object.freeze(results);
}

export function generateUniversalComponentArtifacts(
  hotUpdater: HotUpdaterDBTarget,
): readonly UniversalComponentGeneratedArtifact[] {
  const metadata = getDBMetadata(hotUpdater);
  const schemas = metadata.components?.schemas ?? [];
  const adapter = metadata.universalComponentDataAdapter;
  if (schemas.length === 0 || adapter?.artifacts === undefined) return [];
  const paths = new Set<string>();
  const generated: UniversalComponentGeneratedArtifact[] = [];
  for (const schema of schemas) {
    const expectedVersion = getUniversalComponentLatestSchema(schema).version;
    for (const artifact of adapter.artifacts(schema)) {
      if (
        typeof artifact !== "object" ||
        artifact === null ||
        typeof artifact.path !== "string" ||
        artifact.path.length === 0 ||
        typeof artifact.contents !== "string" ||
        artifact.targetVersion !== expectedVersion ||
        paths.has(artifact.path)
      ) {
        throw new TypeError(
          `Invalid universal component artifact for ${schema.id}.`,
        );
      }
      paths.add(artifact.path);
      generated.push(
        Object.freeze({
          componentId: schema.id,
          contents: artifact.contents,
          path: artifact.path,
          targetVersion: artifact.targetVersion,
        }),
      );
    }
  }
  return Object.freeze(generated);
}
