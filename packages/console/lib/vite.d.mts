import { PluginOption } from "vite";

//#region src/vite.d.ts
interface HotUpdaterConsolePluginOptions {
  readonly auth?: string;
  readonly config?: string;
}
declare const hotUpdaterConsole: (options?: HotUpdaterConsolePluginOptions) => PluginOption[];
//#endregion
export { HotUpdaterConsolePluginOptions, hotUpdaterConsole };