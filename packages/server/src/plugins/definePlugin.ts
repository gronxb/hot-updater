import type { HotUpdaterDatabase } from "../database/database";
import type { ModuleSchema } from "../database/schema";

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

/** The client-route policy a plugin provides, such as API keys. */
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

/** Core's read-only handle for plugins; C1 fills in the reads. */
export type CoreReader = Readonly<Record<never, never>>;

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
  /** Called once at startup, synchronously. */
  init(context: PluginContext<TSchema>): TInstance;
  /** Only core modules carry a kind. */
  readonly kind?: "Core is built in; it is not a plugin";
}

/** Declares a plugin; built-in and third-party plugins use the same contract. */
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
  init(context: PluginContext<TSchema>): InstanceFor<TProvides, TInstance>;
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
