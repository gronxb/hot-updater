import type {
  AnyHotUpdaterPlugin,
  ConfiguredDatabase,
  StorageAdapter,
} from "@hot-updater/plugin-core";

export type ConsoleAuthProvider = "google" | "github";

export type ConsolePrincipal = Readonly<{
  email: string;
  name?: string | null;
  image?: string | null;
}>;

export type ConsoleAccess =
  | { status: "unauthenticated" }
  | { status: "forbidden"; principal: ConsolePrincipal }
  | { status: "authorized"; principal: ConsolePrincipal };

export type ConsoleAuthAdapter = Readonly<{
  handle(request: Request): Promise<Response>;
  getAccess(request: Request): Promise<ConsoleAccess>;
  getProviders(request: Request): Promise<readonly ConsoleAuthProvider[]>;
}>;

export type HotUpdaterConsoleConfig = Readonly<{
  /**
   * The database your server runs on, such as `dynamoDB(...)`, or
   * `standaloneRepository(...)`, which reaches a self-hosted server through
   * its admin API.
   */
  database: ConfiguredDatabase;
  /** The storage your server lists; the console reads bundle files with it. */
  storage: StorageAdapter;
  /**
   * The plugins your server runs, such as the `plugins` a managed provider
   * package exports or `[insights(), apiKeys()]`. The console runs them over
   * `database` as the server does, and shows only the built-in features of
   * the plugins listed. With `standaloneRepository`, they run on the server,
   * and the console shows the features its admin API serves.
   */
  plugins?: readonly AnyHotUpdaterPlugin[];
  console?: {
    /** The Git repository whose commits the console links bundles to. */
    gitUrl?: string;
  };
}>;

export type HotUpdaterConsoleConfigSource =
  | HotUpdaterConsoleConfig
  | ((
      request: Request,
    ) => HotUpdaterConsoleConfig | Promise<HotUpdaterConsoleConfig>);

export const defineConsoleConfig = <
  const TConfig extends HotUpdaterConsoleConfigSource,
>(
  config: TConfig,
): TConfig => config;
