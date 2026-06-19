import {
  createHotUpdaterCore,
  type CreateHotUpdaterOptions,
  type RuntimeHotUpdaterAPI,
} from "./createHotUpdaterCore";

export function createHotUpdater<TContext = unknown>(
  options: CreateHotUpdaterOptions<TContext>,
): RuntimeHotUpdaterAPI<TContext> {
  return createHotUpdaterCore(options).api;
}

export { createHandler } from "./handler";
export type {
  CreateHotUpdaterOptions,
  RuntimeHotUpdaterAPI,
  RuntimeHotUpdaterAPI as HotUpdaterAPI,
};
export { HOT_UPDATER_SERVER_VERSION } from "./version";
