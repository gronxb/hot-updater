import type { HotUpdaterContext } from "@hot-updater/plugin-core";

import {
  createHotUpdaterCore,
  type CreateHotUpdaterOptions,
} from "../createHotUpdaterCore";
import { generateSchemaFromHotUpdaterSchema } from "./schemaGenerators";
import { type DatabaseAPI, type Migrator, type SchemaGenerator } from "./types";

export * from "./createBundleDiff";
export type { Migrator, SchemaGenerator } from "./types";
export { HotUpdaterSchemaMigrationRequiredError } from "./schemaReadiness";
export { HOT_UPDATER_SERVER_VERSION } from "../version";

export type HotUpdaterAPI<TContext = unknown> = DatabaseAPI<TContext> & {
  readonly basePath: string;
  readonly handler: (
    request: Request,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Response>;
  readonly adapterName: string;
  readonly createMigrator: () => Migrator;
  readonly generateSchema: SchemaGenerator;
};

export type { CreateHotUpdaterOptions };

export function createHotUpdater<TContext = unknown>(
  options: CreateHotUpdaterOptions<TContext>,
): HotUpdaterAPI<TContext> {
  const {
    api: runtimeApi,
    adapterCapabilities,
    core,
  } = createHotUpdaterCore(options);
  const generateSchema =
    adapterCapabilities.generateSchema ?? core.generateSchema;
  const api = {
    basePath: runtimeApi.basePath,
    adapterName: runtimeApi.adapterName,
    createMigrator: adapterCapabilities.createMigrator ?? core.createMigrator,
    generateSchema: (...args: Parameters<SchemaGenerator>) =>
      generateSchemaFromHotUpdaterSchema(
        api.adapterName,
        adapterCapabilities.provider,
        args[0],
        generateSchema(...args),
      ),
    handler: runtimeApi.handler,
  };
  Object.defineProperties(api, Object.getOwnPropertyDescriptors(core.api));
  return api as HotUpdaterAPI<TContext>;
}
