import type { ConfigInput } from "@hot-updater/plugin-core";

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

export type ConsoleSigningConfig = Readonly<{
  enabled: boolean;
  provider?: string;
  publicKeyPath?: string;
}>;

export type HotUpdaterConsoleConfig = Readonly<
  Pick<ConfigInput, "console" | "database" | "signing" | "storage">
>;

export type ResolvedHotUpdaterConsoleConfig = Readonly<
  Omit<HotUpdaterConsoleConfig, "signing"> & {
    signing?: ConsoleSigningConfig;
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
