import {
  defineUniversalComponentSchema,
  getUniversalComponentLatestSchema,
  type UniversalComponentDataAdapter,
  type UniversalComponentDataSource,
  type UniversalComponentSchema,
} from "@hot-updater/plugin-core";

import { v0_36_0 } from "../schema/v0_36_0";
import { HotUpdaterConstructionError } from "./errors";
import type { FirstPartyServerPlugin } from "./manifest";
import { suppressNativePromiseRejection } from "./promise";

export interface HotUpdaterPluginComponents {
  get(
    schema: UniversalComponentSchema,
  ): UniversalComponentDataSource | undefined;
  require(schema: UniversalComponentSchema): UniversalComponentDataSource;
}

export interface UniversalComponentRegistry extends HotUpdaterPluginComponents {
  readonly schemas: readonly UniversalComponentSchema[];
  readonly sources: readonly UniversalComponentDataSource[];
  forPlugin(pluginId: string): HotUpdaterPluginComponents;
}

export type UniversalComponentSchemaPlan = {
  readonly declarations: readonly {
    readonly pluginId: string;
    readonly schema: UniversalComponentSchema;
  }[];
  readonly schemas: readonly UniversalComponentSchema[];
};

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const isDeepFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (!isObject(value) || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).every((key) =>
    isDeepFrozen(Reflect.get(value, key), seen),
  );
};

const validateSchema = (
  pluginId: string,
  value: UniversalComponentSchema,
): UniversalComponentSchema => {
  try {
    const parsed = defineUniversalComponentSchema(value);
    if (
      !isDeepFrozen(value) ||
      JSON.stringify(parsed) !== JSON.stringify(value)
    ) {
      throw new TypeError("Schema must be a canonical immutable definition.");
    }
    return value;
  } catch {
    throw new HotUpdaterConstructionError("INVALID_COMPONENT_SCHEMA", {
      pluginId,
    });
  }
};

export const collectUniversalComponentSchemas = (
  plugins: readonly FirstPartyServerPlugin[],
): UniversalComponentSchemaPlan => {
  const declarations = plugins
    .flatMap((plugin) =>
      plugin.schema === undefined
        ? []
        : [
            {
              pluginId: plugin.id,
              schema: validateSchema(plugin.id, plugin.schema),
            },
          ],
    )
    .sort(
      (left, right) =>
        left.schema.id.localeCompare(right.schema.id) ||
        left.pluginId.localeCompare(right.pluginId),
    );
  const componentIds = new Set<string>();
  const physicalTables = new Map<string, string>(
    v0_36_0.tables.map(({ ormName }) => [ormName, "core"] as const),
  );
  const physicalIndexes = new Map<string, string>(
    v0_36_0.tables.flatMap((table) =>
      (table.indexes ?? [])
        .filter(
          ({ providers }) =>
            providers === undefined ||
            providers.some((provider) => provider !== "mongodb"),
        )
        .map(({ name }) => [name, `core/${table.ormName}`] as const),
    ),
  );

  for (const { schema } of declarations) {
    if (componentIds.has(schema.id)) {
      throw new HotUpdaterConstructionError("DUPLICATE_COMPONENT_ID", {
        componentId: schema.id,
      });
    }
    componentIds.add(schema.id);

    for (const version of schema.versions) {
      for (const table of version.tables) {
        const tableOwner = physicalTables.get(table.name);
        if (tableOwner !== undefined && tableOwner !== schema.id) {
          throw new HotUpdaterConstructionError("DUPLICATE_COMPONENT_TABLE", {
            tableName: table.name,
          });
        }
        physicalTables.set(table.name, schema.id);

        const indexOwner = `${schema.id}/${table.name}`;
        for (const { name } of table.indexes ?? []) {
          const previousOwner = physicalIndexes.get(name);
          if (previousOwner !== undefined && previousOwner !== indexOwner) {
            throw new HotUpdaterConstructionError("DUPLICATE_COMPONENT_INDEX", {
              indexName: name,
            });
          }
          physicalIndexes.set(name, indexOwner);
        }
      }
    }
  }

  return Object.freeze({
    declarations: Object.freeze(declarations),
    schemas: Object.freeze(declarations.map(({ schema }) => schema)),
  });
};

const invalidAdapter = (componentId: string): never => {
  throw new HotUpdaterConstructionError("INVALID_COMPONENT_DATA_ADAPTER", {
    componentId,
  });
};

const bindSource = (
  adapter: UniversalComponentDataAdapter,
  schema: UniversalComponentSchema,
): UniversalComponentDataSource => {
  let source: unknown;
  try {
    source = adapter.bind(schema);
    if (isObject(source) && typeof Reflect.get(source, "then") === "function") {
      suppressNativePromiseRejection(source);
      return invalidAdapter(schema.id);
    }
    if (
      !isObject(source) ||
      Reflect.get(source, "schema") !== schema ||
      typeof Reflect.get(source, "append") !== "function" ||
      typeof Reflect.get(source, "assertReady") !== "function" ||
      typeof Reflect.get(source, "create") !== "function" ||
      typeof Reflect.get(source, "get") !== "function" ||
      typeof Reflect.get(source, "orderedScan") !== "function"
    ) {
      return invalidAdapter(schema.id);
    }
    return source as UniversalComponentDataSource;
  } catch (error) {
    if (error instanceof HotUpdaterConstructionError) throw error;
    return invalidAdapter(schema.id);
  }
};

export const bindUniversalComponentSchemas = (
  plan: UniversalComponentSchemaPlan,
  adapter: UniversalComponentDataAdapter | undefined,
): UniversalComponentRegistry => {
  if (plan.schemas.length > 0 && adapter === undefined) {
    throw new HotUpdaterConstructionError("MISSING_COMPONENT_DATA_ADAPTER", {
      componentIds: plan.schemas.map(({ id }) => id),
    });
  }

  const sources = plan.schemas.map((schema) => bindSource(adapter!, schema));
  const sourceBySchema = new Map(
    plan.schemas.map((schema, index) => [schema, sources[index]!] as const),
  );
  const schemaByPlugin = new Map(
    plan.declarations.map(
      ({ pluginId, schema }) => [pluginId, schema] as const,
    ),
  );

  const createView = (
    allowedSchema?: UniversalComponentSchema,
  ): HotUpdaterPluginComponents => {
    const get = (schema: UniversalComponentSchema) =>
      schema === allowedSchema ? sourceBySchema.get(schema) : undefined;
    return Object.freeze({
      get,
      require(schema: UniversalComponentSchema) {
        const source = get(schema);
        if (source === undefined) {
          throw new TypeError(
            `Component ${schema.id}@${getUniversalComponentLatestSchema(schema).version} is not declared by this plugin.`,
          );
        }
        return source;
      },
    });
  };

  const globalView = Object.freeze({
    get: (schema: UniversalComponentSchema) => sourceBySchema.get(schema),
    require(schema: UniversalComponentSchema) {
      const source = sourceBySchema.get(schema);
      if (source === undefined) {
        throw new TypeError(`Unknown component schema: ${schema.id}`);
      }
      return source;
    },
  });

  return Object.freeze({
    forPlugin: (pluginId: string) => createView(schemaByPlugin.get(pluginId)),
    get: globalView.get,
    require: globalView.require,
    schemas: plan.schemas,
    sources: Object.freeze(sources),
  });
};
