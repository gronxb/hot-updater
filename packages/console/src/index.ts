import type { RemoteServer } from "@hot-updater/plugin-core";
import type { HotUpdaterAPI } from "@hot-updater/server";

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
   * The server the console manages: your server definition, the
   * `hotUpdater` that `createHotUpdater({ database, storage, plugins })`
   * returns, or `standaloneRepository(...)`, which reaches a self-hosted
   * server through its admin API. The console shows the built-in features
   * of the plugins the server runs: the definition's, or those its admin
   * `/version` lists.
   */
  server: HotUpdaterAPI | RemoteServer;
  /** The Git repository whose commits the console links bundles to. */
  gitUrl?: string;
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
