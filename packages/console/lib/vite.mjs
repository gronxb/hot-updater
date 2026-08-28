import { createHostedConsolePlugins } from "./vite-internal.mjs";
//#region src/vite.ts
const hotUpdaterConsole = (options = {}) => createHostedConsolePlugins(options);
//#endregion
export { hotUpdaterConsole };
