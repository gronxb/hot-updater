import type { CoreReads } from "../core/reads";
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

/** A positional argument of a plugin command. */
export interface PluginCommandArgument {
  /** The key of its value in `args`. */
  readonly name: string;
  readonly description: string;
  /** Defaults to true. */
  readonly required?: boolean;
}

/** An option of a plugin command. */
export interface PluginCommandOption {
  /** Flags as the CLI writes them, such as `--name <name>` or `-y, --yes`. */
  readonly flags: string;
  readonly description: string;
  /** The command fails without it. */
  readonly required?: boolean;
}

export interface PluginTableColumn<TKey extends string> {
  readonly key: TKey;
  readonly label?: string;
  /** Styles the padded cell. */
  readonly format?: (value: string) => string;
}

/**
 * The CLI's output style, so plugin commands read like core ones: the
 * formatters return styled text, and the writers print it.
 */
export interface PluginCommandUi {
  block(heading: string, lines: readonly string[]): string;
  kv(label: string, value: string): string;
  table<TKey extends string>(
    columns: readonly PluginTableColumn<TKey>[],
    rows: readonly Readonly<Record<TKey, string>>[],
  ): string;
  id(value: string): string;
  muted(value: string): string;
  success(value: string): string;
  danger(value: string): string;
  warning(value: string): string;
  message(text: string): void;
  info(text: string): void;
  warn(text: string): void;
  /** Writes machine-readable output, such as JSON, to stdout. */
  print(text: string): void;
  /**
   * Returns once the user agrees to `message`. Declining ends the command,
   * and a non-interactive shell fails it, asking for `-y`.
   */
  confirm(message: string): Promise<void>;
}

/** A plugin command run over a database the CLI opens itself. */
export interface PluginCommandContext<Api = unknown> {
  /** The plugin's API over that database, assembled as the server assembles it. */
  readonly api: Api;
  /** Positional arguments by name. */
  readonly args: Readonly<Record<string, string | undefined>>;
  /** Options by camel-cased long flag: `dryRun` for `--dry-run`. */
  readonly options: Readonly<Record<string, unknown>>;
  readonly ui: PluginCommandUi;
}

/**
 * A `hot-updater` command a plugin adds. It groups `commands`, or runs `run`
 * over a database the CLI opens itself, so it refuses a `standaloneRepository`
 * config. A command that runs also takes the server config's path as its
 * last, optional argument.
 */
export interface PluginCommand<Api = unknown> {
  /** Lowercase words joined by hyphens, such as `api-key`. */
  readonly name: string;
  readonly description: string;
  readonly arguments?: readonly PluginCommandArgument[];
  readonly options?: readonly PluginCommandOption[];
  readonly commands?: readonly PluginCommand<Api>[];
  run?(context: PluginCommandContext<Api>): Promise<void>;
}

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

/** What a plugin adds to the `hot-updater` CLI. */
export interface PluginCli<Api = unknown> {
  /** Commands the CLI finds in the project's plugins. */
  readonly commands?: readonly PluginCommand<Api>[];
  /** Needs provides: { clientAuth: true }. */
  readonly clientCredential?: PluginClientCredential<Api>;
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
  /** Called once at startup, synchronously. */
  init(context: PluginContext<TSchema>): TInstance;
  /** Read by the CLI only; the server never runs it. */
  readonly cli?: PluginCli<TInstance["api"]>;
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
