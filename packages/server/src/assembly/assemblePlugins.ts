import type { DatabaseAdapter } from "@hot-updater/plugin-core/internal";

import { createCoreApi, type CoreApi } from "../core/api";
import { createCoreReads, type CoreStorage } from "../core/reads";
import { coreModule } from "../core/schema";
import { createDatabaseEngine } from "../database/database";
import { resolveSchema, type SchemaModule } from "../database/resolveSchema";
import type { ModuleSchema } from "../database/schema";
import { builtInPlugin } from "../plugins/builtIn";
import type {
  ClientAuth,
  PluginEndpoint,
  PluginInstance,
} from "../plugins/definePlugin";

/** A misconfigured `createHotUpdater` call, reported at startup. */
export class HotUpdaterConfigError extends Error {
  readonly name = "HotUpdaterConfigError";
}

export interface MountedEndpoint extends PluginEndpoint {
  readonly plugin: string;
}

export interface AssembledPlugins {
  /** Core's reads and typed writes, on the same engine as the plugins, which get only the reads. */
  readonly core: CoreApi;
  readonly api: Readonly<Record<string, unknown>>;
  readonly endpoints: readonly MountedEndpoint[];
  readonly clientAuth?: ClientAuth & { readonly plugin: string };
}

interface PluginShape {
  readonly id: string;
  readonly provides?: { readonly clientAuth?: true };
  readonly schemaVersion: string;
  readonly schema: ModuleSchema;
  init(context: unknown): PluginInstance;
  readonly [builtInPlugin]?: true;
}

const PLUGIN_KEYS = new Set([
  "id",
  "provides",
  "schemaVersion",
  "schema",
  "init",
]);
const INSTANCE_KEYS = new Set(["api", "endpoints", "clientAuth"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const BUILT_IN_ID = /^[a-z][A-Za-z0-9]*$/u;
const PLUGIN_ID = /^[a-z][a-z0-9_]*$/u;
const PATH = /^(\/(:?[A-Za-z0-9_.~-]+))+$/u;

const fail = (message: string): never => {
  throw new HotUpdaterConfigError(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const checkPlugin = (value: unknown, at: string): PluginShape => {
  if (!isRecord(value)) return fail(`${at} is not a plugin.`);
  if ("kind" in value) {
    fail(`${at} has a kind; core is built in and is never passed as a plugin.`);
  }
  const unknown = Object.keys(value).find((key) => !PLUGIN_KEYS.has(key));
  if (unknown !== undefined) fail(`${at} has an unknown key "${unknown}".`);
  const plugin = value as unknown as PluginShape;
  const pattern = plugin[builtInPlugin] ? BUILT_IN_ID : PLUGIN_ID;
  if (typeof plugin.id !== "string" || !pattern.test(plugin.id)) {
    fail(`${at} needs an id matching ${pattern.source}.`);
  }
  if (plugin.id === coreModule.id) {
    fail(`${at} uses the id "core", which is core's own.`);
  }
  if (
    typeof plugin.schemaVersion !== "string" ||
    !isRecord(plugin.schema) ||
    typeof plugin.init !== "function"
  ) {
    fail(`Plugin "${plugin.id}" needs a schemaVersion, a schema, and init.`);
  }
  const provides = plugin.provides as unknown;
  if (
    provides !== undefined &&
    (!isRecord(provides) ||
      Object.entries(provides).some(
        ([key, flag]) => key !== "clientAuth" || flag !== true,
      ))
  ) {
    fail(
      `Plugin "${plugin.id}" may only declare provides: { clientAuth: true }.`,
    );
  }
  return plugin;
};

const checkEndpoint = (id: string, value: unknown): MountedEndpoint => {
  const endpoint = (isRecord(value) ? value : {}) as Partial<PluginEndpoint>;
  if (
    !METHODS.has(endpoint.method as string) ||
    typeof endpoint.path !== "string" ||
    !PATH.test(endpoint.path) ||
    (endpoint.access !== "client" && endpoint.access !== "admin") ||
    typeof endpoint.handler !== "function"
  ) {
    fail(
      `Plugin "${id}" has an endpoint that needs a method, a path like /name/:param, access "client" or "admin", and a handler.`,
    );
  }
  return { ...(endpoint as PluginEndpoint), plugin: id };
};

const checkInstance = (plugin: PluginShape, instance: unknown) => {
  const { id } = plugin;
  if (!isRecord(instance))
    return fail(`Plugin "${id}" init returned no instance.`);
  if (typeof instance.then === "function") {
    fail(`Plugin "${id}" init returned a promise; init must be synchronous.`);
  }
  const unknown = Object.keys(instance).find((key) => !INSTANCE_KEYS.has(key));
  if (unknown !== undefined || !("api" in instance)) {
    fail(
      `Plugin "${id}" init must return { api, endpoints?, clientAuth? }${unknown === undefined ? "" : `, not "${unknown}"`}.`,
    );
  }
  const declared = plugin.provides?.clientAuth === true;
  const clientAuth = instance.clientAuth as ClientAuth | undefined;
  if (declared !== (clientAuth !== undefined)) {
    fail(
      declared
        ? `Plugin "${id}" declares provides: { clientAuth: true } but its instance has no clientAuth.`
        : `Plugin "${id}" returns clientAuth without declaring provides: { clientAuth: true }.`,
    );
  }
  if (
    clientAuth !== undefined &&
    (typeof clientAuth.authenticate !== "function" ||
      !Array.isArray(clientAuth.varyHeaders) ||
      !clientAuth.varyHeaders.every((header) => typeof header === "string"))
  ) {
    fail(`Plugin "${id}" clientAuth needs varyHeaders and authenticate.`);
  }
  const endpoints = instance.endpoints ?? [];
  if (!Array.isArray(endpoints))
    fail(`Plugin "${id}" endpoints must be an array.`);
  return {
    api: instance.api,
    clientAuth,
    endpoints: (endpoints as unknown[]).map((endpoint) =>
      checkEndpoint(id, endpoint),
    ),
  };
};

/**
 * Checks every plugin, runs each `init` once against one engine over the
 * database's storage adapter, and collects APIs, endpoints, and clientAuth.
 * Core's reads run on the same engine, so plugins read core through `ctx.core`.
 */
export const assemblePlugins = (
  value: unknown,
  adapter: DatabaseAdapter,
  {
    now = Date.now,
    storage = { resolveFileUrl: async () => null },
  }: { readonly now?: () => number; readonly storage?: CoreStorage } = {},
): AssembledPlugins => {
  if (!Array.isArray(value))
    return fail("plugins must be an array of plugins.");
  const plugins = value.map((plugin, position) =>
    checkPlugin(plugin, `plugins[${position}]`),
  );
  const ids = new Set<string>();
  for (const { id } of plugins) {
    if (ids.has(id)) fail(`Plugin "${id}" is registered twice.`);
    ids.add(id);
  }
  const modules: (SchemaModule & { readonly schema: ModuleSchema })[] =
    plugins.map((plugin) => ({
      id: plugin.id,
      schema: plugin.schema,
      ...(plugin[builtInPlugin] ? {} : { namespace: plugin.id }),
    }));
  const engine = createDatabaseEngine({
    adapter,
    schema: resolveSchema([coreModule, ...modules]),
  });
  const coreDatabase = engine.database(coreModule);
  const core = createCoreApi(coreDatabase, storage, { now });
  const reads = createCoreReads(coreDatabase, storage);
  const api: Record<string, unknown> = {};
  const endpoints: MountedEndpoint[] = [];
  let clientAuth: AssembledPlugins["clientAuth"];
  plugins.forEach((plugin, position) => {
    const instance = checkInstance(
      plugin,
      plugin.init({
        db: engine.database(modules[position]!),
        core: reads,
        now,
      }),
    );
    if (instance.clientAuth !== undefined) {
      if (clientAuth !== undefined) {
        fail(
          `Plugins "${clientAuth.plugin}" and "${plugin.id}" both provide clientAuth; keep one.`,
        );
      }
      const provided = instance.clientAuth;
      clientAuth = {
        plugin: plugin.id,
        varyHeaders: provided.varyHeaders,
        authenticate: (headers) => provided.authenticate(headers),
      };
    }
    endpoints.push(...instance.endpoints);
    api[plugin.id] = instance.api;
  });
  return clientAuth === undefined
    ? { core, api, endpoints }
    : { core, api, endpoints, clientAuth };
};
