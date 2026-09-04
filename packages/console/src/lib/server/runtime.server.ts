import type {
  ApiKeyModel,
  BundleRepository,
  DatabasePlugin,
} from "@hot-updater/plugin-core";
import {
  createInsightsProvider,
  type InsightsProvider,
} from "@hot-updater/server";

export function createRuntimeHotUpdater(config: {
  readonly database: DatabasePlugin;
}): InsightsProvider {
  return createInsightsProvider(config.database.models.insights);
}

export function createApiKeyStore(config: {
  readonly database: BundleRepository;
}): ApiKeyModel | null {
  const models: unknown = Reflect.get(config.database, "models");
  const apiKeys: unknown =
    typeof models === "object" && models !== null
      ? Reflect.get(models, "apiKeys")
      : undefined;
  if (
    typeof apiKeys !== "object" ||
    apiKeys === null ||
    typeof Reflect.get(apiKeys, "create") !== "function" ||
    typeof Reflect.get(apiKeys, "findByHash") !== "function" ||
    typeof Reflect.get(apiKeys, "list") !== "function" ||
    typeof Reflect.get(apiKeys, "revoke") !== "function"
  ) {
    return null;
  }
  return apiKeys as ApiKeyModel;
}
