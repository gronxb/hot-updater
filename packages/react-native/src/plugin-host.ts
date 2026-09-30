/**
 * The plugin host the app runs client plugins on, for
 * `@hot-updater/test-utils`, which runs them on the same code in tests.
 * Not a public API: it can change in any release.
 */
export { resolveBaseURL } from "./baseURL";
export { createPluginHost, pluginStorageKey } from "./createPluginHost";
export type {
  PluginHookName,
  PluginHookPayload,
  PluginHost,
  PluginHostConfig,
  PluginHostEnvironment,
} from "./createPluginHost";
