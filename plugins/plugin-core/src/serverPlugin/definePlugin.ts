import type { CoreReads } from "./coreReads";
import type { HotUpdaterDatabase } from "./databaseHandle";
import type { ModuleSchema } from "./schema";

export type PluginEndpointMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface PluginEndpoint {
  readonly method: PluginEndpointMethod;
  /** Relative to the handler's mount; `:name` segments become `params`. */
  readonly path: string;
  /**
   * `"client"` mounts on `handlers.client` behind the client-route policy;
   * `"admin"` mounts on `handlers.admin`, which the host protects.
   */
  readonly access: "client" | "admin";
  readonly handler: (
    request: Request,
    params: Readonly<Record<string, string>>,
  ) => Promise<Response>;
}

/** The client-route policy a plugin provides, such as a key or token check. */
export interface ClientAuth {
  /** Request headers the decision reads; core adds them to `Vary` on cacheable client responses. */
  readonly varyHeaders: readonly string[];
  /** Whether the request may use client routes; a throw answers 503. */
  authenticate(headers: Headers): Promise<boolean>;
}

export interface PluginInstance<Api = unknown> {
  readonly api: Api;
  readonly endpoints?: readonly PluginEndpoint[];
  readonly clientAuth?: ClientAuth;
}

/** Core's reads: bundles, Releases, Catalogs, and channels, each through a declared index. Plugins never write core. */
export type CoreReader = CoreReads;

export interface PluginContext<S extends ModuleSchema> {
  /** The plugin's own tables and aggregates. */
  readonly db: HotUpdaterDatabase<S>;
  readonly core: CoreReader;
  now(): number;
}

export interface PluginProvides {
  readonly clientAuth?: true;
}

/** An instance whose `clientAuth` matches what the plugin declares it provides. */
export type InstanceFor<TProvides, TInstance> = TProvides extends {
  readonly clientAuth: true;
}
  ? TInstance & { readonly clientAuth: ClientAuth }
  : TInstance & {
      readonly clientAuth?: "Declare provides: { clientAuth: true } to return clientAuth";
    };

/**
 * The credential an app sends to client routes that the plugin's clientAuth
 * guards. Init provisions it and prints the header to send, the agent
 * scaffold stores it, and doctor checks it.
 */
export interface PluginClientCredential<Api = unknown> {
  /** Its name in output, such as "API key". */
  readonly label: string;
  /** The request header that carries it, one of clientAuth's varyHeaders. */
  readonly header: string;
  /** The environment variable init stores it in. */
  readonly env: string;
  /** A new credential, made without a database, so tooling can save it before registering it. */
  generate(): string;
  /** Registers `existing` idempotently, or creates one; returns the credential. */
  provision(
    api: Api,
    input: { readonly existing?: string; readonly name: string },
  ): Promise<string>;
}

/**
 * A client plugin an app adds to `HotUpdater.init`'s `plugins` to work with
 * the server plugin. Init prints it in the app code, and the agent scaffold
 * asks for it.
 */
export interface PluginClientPlugin {
  /** The module that exports it, such as `@hot-updater/react-native`, which exports `insights`. */
  readonly module: string;
  /** The export, which the app calls with no arguments, such as `insights`. */
  readonly name: string;
}

/**
 * What the CLI reads from a plugin: the credential init provisions, and the
 * client plugin init prints and doctor checks.
 */
export interface PluginCli<Api = unknown> {
  /** Needs provides: { clientAuth: true }. */
  readonly clientCredential?: PluginClientCredential<Api>;
  readonly clientPlugin?: PluginClientPlugin;
}

/** CLI additions whose `clientCredential` matches what the plugin declares it provides. */
export type CliFor<TProvides, TApi> = TProvides extends {
  readonly clientAuth: true;
}
  ? PluginCli<TApi>
  : Omit<PluginCli<TApi>, "clientCredential"> & {
      readonly clientCredential?: "Declare provides: { clientAuth: true } to add clientCredential";
    };

export interface HotUpdaterPlugin<
  TId extends string = string,
  TSchema extends ModuleSchema = ModuleSchema,
  TInstance extends PluginInstance = PluginInstance,
  TProvides extends PluginProvides = PluginProvides,
> {
  readonly id: TId;
  /** Static, so the type system and startup can count client-route policies. */
  readonly provides?: TProvides;
  /** Stored under the settings key `schema.<id>`. */
  readonly schemaVersion: string;
  readonly schema: TSchema;
  /**
   * `false` keeps the declared table names instead of prefixing them with
   * the plugin's id. The plugin then owns collisions with core's tables and
   * other plugins' tables, which startup checks for the plugins a server
   * runs, and only such a plugin may take a camelCase id.
   */
  readonly namespace?: false;
  /** Called once at startup, synchronously. */
  init(context: PluginContext<TSchema>): TInstance;
  /** Read by the CLI only; the server never runs it. */
  readonly cli?: PluginCli<TInstance["api"]>;
  /** Only core modules carry a kind. */
  readonly kind?: "Core is built in; it is not a plugin";
}

/** Declares a plugin; Hot Updater's own plugins and third-party ones use the same contract. */
export const definePlugin = <
  const TId extends string,
  const TSchema extends ModuleSchema,
  TInstance extends PluginInstance,
  const TProvides extends PluginProvides = {},
>(plugin: {
  readonly id: TId;
  readonly provides?: TProvides;
  readonly schemaVersion: string;
  readonly schema: TSchema;
  readonly namespace?: false;
  init(context: PluginContext<TSchema>): InstanceFor<TProvides, TInstance>;
  readonly cli?: CliFor<TProvides, NoInfer<TInstance["api"]>>;
}): HotUpdaterPlugin<TId, TSchema, TInstance, TProvides> =>
  plugin as HotUpdaterPlugin<TId, TSchema, TInstance, TProvides>;

/** Any plugin, whatever its schema and API. */
export type AnyHotUpdaterPlugin = HotUpdaterPlugin<string, any, any, any>;

/** Each plugin's API by id. */
export type PluginApis<TPlugins extends readonly AnyHotUpdaterPlugin[]> = {
  readonly [TPlugin in TPlugins[number] as TPlugin["id"]]: ReturnType<
    TPlugin["init"]
  >["api"];
};
