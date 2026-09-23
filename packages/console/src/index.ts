import type { ConfigInput, DatabasePlugin } from "@hot-updater/plugin-core";
import type { AnyHotUpdaterPlugin } from "@hot-updater/server/plugins";

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

export type HotUpdaterConsoleConfig = Readonly<
  Omit<Pick<ConfigInput, "console" | "database" | "storage">, "database"> & {
    database: DatabasePlugin;
    /**
     * The plugins your server runs, such as `[insights(), apiKeys()]`. The
     * console runs them over `database` to read Insights and manage API
     * keys, and shows a plugin that is not listed as off. Without it, the
     * database plugin serves both until 1.0. A `standaloneRepository`
     * database needs none: its server answers for its plugins.
     */
    plugins?: readonly AnyHotUpdaterPlugin[];
  }
>;

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
