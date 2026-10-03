import {
  createEngine,
  type EngineDatabase,
  type ModuleSchema,
} from "@hot-updater/plugin-core";

import { createCoreApi, type CoreApi } from "../core/api";
import { createCoreReads, type CoreStorage } from "../core/reads";
import type {
  ClientAuth,
  PluginEndpoint,
  PluginInstance,
} from "../plugins/definePlugin";
import { checkReservedId } from "../plugins/official";
import { clientPluginsOf } from "./clientPlugins";
import { HotUpdaterConfigError } from "./configError";

export { HotUpdaterConfigError };

export interface MountedEndpoint extends PluginEndpoint {
  readonly plugin: string;
}

export interface AssembledPlugins {
  /** Core's reads and typed writes, on the same engine as the plugins, which get only the reads. */
  readonly core: CoreApi;
  readonly api: Readonly<Record<string, unknown>>;
  readonly endpoints: readonly MountedEndpoint[];
  readonly clientAuth?: ClientAuth & { readonly plugin: string };
  /** Applies batched aggregate changes still pending. */
  readonly flush: () => Promise<void>;
}

interface PluginShape {
  readonly id: string;
  readonly provides?: { readonly clientAuth?: true };
  readonly schemaVersion: string;
  readonly schema: ModuleSchema;
  readonly namespace?: false;
  init(context: unknown): PluginInstance;
}

const PLUGIN_KEYS = new Set([
  "id",
  "provides",
  "schemaVersion",
  "schema",
  "namespace",
  "init",
  "cli",
]);
const CLI_KEYS = new Set(["clientCredential", "clientPlugin"]);
const INSTANCE_KEYS = new Set(["api", "endpoints", "clientAuth"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
/** An id that prefixes table names is a SQL name; one that does not may use camelCase. */
const PREFIX_ID = /^[a-z][a-z0-9_]*$/u;
const UNPREFIXED_ID = /^[a-z][A-Za-z0-9_]*$/u;
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
  if (plugin.namespace !== undefined && plugin.namespace !== false) {
    fail(`${at} may only set namespace: false.`);
  }
  const pattern = plugin.namespace === false ? UNPREFIXED_ID : PREFIX_ID;
  if (typeof plugin.id !== "string" || !pattern.test(plugin.id)) {
    fail(`${at} needs an id matching ${pattern.source}.`);
  }
  if (plugin.id === "core") {
    fail(`${at} uses the id "core", which is core's own.`);
  }
  checkReservedId(value, at);
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
  const cli = value.cli;
  if (cli !== undefined) {
    if (!isRecord(cli) || Object.keys(cli).some((key) => !CLI_KEYS.has(key))) {
      fail(
        `Plugin "${plugin.id}" cli may only hold clientCredential and clientPlugin.`,
      );
    }
    if (
      (cli as Record<string, unknown>).clientCredential !== undefined &&
      plugin.provides?.clientAuth !== true
    ) {
      fail(
        `Plugin "${plugin.id}" adds cli.clientCredential without declaring provides: { clientAuth: true }.`,
      );
    }
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
 * database, and collects APIs, endpoints, and clientAuth. Core's reads run
 * on the same engine, so plugins read core through `ctx.core`.
 */
export const assemblePlugins = (
  value: unknown,
  database: EngineDatabase,
  {
    now = Date.now,
    storage = { resolveFileUrl: async () => null },
  }: {
    readonly now?: () => number;
    readonly storage?: CoreStorage;
  } = {},
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
  // Tooling prints them; a server checks them at startup like the rest.
  clientPluginsOf(plugins);
  const engine = createEngine(database, { plugins, now });
  const { onCachedRoutesChange } = database;
  const core = createCoreApi(engine.core, storage, {
    now,
    ...(onCachedRoutesChange === undefined
      ? {}
      : { onCachedRoutesChange: () => onCachedRoutesChange.call(database) }),
  });
  const reads = createCoreReads(engine.core, storage);
  const api: Record<string, unknown> = {};
  const endpoints: MountedEndpoint[] = [];
  let clientAuth: AssembledPlugins["clientAuth"];
  for (const plugin of plugins) {
    const instance = checkInstance(
      plugin,
      plugin.init({ db: engine.database(plugin), core: reads, now }),
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
  }
  return {
    core,
    api,
    endpoints,
    ...(clientAuth === undefined ? {} : { clientAuth }),
    flush: engine.flush,
  };
};
