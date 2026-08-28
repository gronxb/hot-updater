import { ConfigInput } from "@hot-updater/plugin-core";

//#region src/index.d.ts
type ConsoleAuthProvider = "google" | "github";
type ConsolePrincipal = Readonly<{
  email: string;
  name?: string | null;
  image?: string | null;
}>;
type ConsoleAccess = {
  status: "unauthenticated";
} | {
  status: "forbidden";
  principal: ConsolePrincipal;
} | {
  status: "authorized";
  principal: ConsolePrincipal;
};
type ConsoleAuthAdapter = Readonly<{
  handle(request: Request): Promise<Response>;
  getAccess(request: Request): Promise<ConsoleAccess>;
  getProviders(request: Request): Promise<readonly ConsoleAuthProvider[]>;
}>;
type HotUpdaterConsoleConfig = Readonly<Pick<ConfigInput, "authorityId" | "console" | "database" | "storage">>;
type HotUpdaterConsoleConfigSource = HotUpdaterConsoleConfig | ((request: Request) => HotUpdaterConsoleConfig | Promise<HotUpdaterConsoleConfig>);
declare const defineConsoleConfig: <const TConfig extends HotUpdaterConsoleConfigSource>(config: TConfig) => TConfig;
//#endregion
export { ConsoleAccess, ConsoleAuthAdapter, ConsoleAuthProvider, ConsolePrincipal, HotUpdaterConsoleConfig, HotUpdaterConsoleConfigSource, defineConsoleConfig };