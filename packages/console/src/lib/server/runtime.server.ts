import type {
  ApiKeyModel,
  ApiKeyRow,
  InsightsModel,
} from "@hot-updater/plugin-core";
import {
  type ApiKeyManagementAPI,
  createApiKey,
  createInsightsProvider,
} from "@hot-updater/server";
import { createDatabasePluginApis } from "@hot-updater/server/db";
import {
  createInsightsModel,
  type InsightsApi,
} from "@hot-updater/server/plugins/insights";

import {
  type ConsoleInsightsReads,
  createAdminInsightsReads,
  type FetchAdmin,
  InsightsOffError,
} from "./adminInsights";

/** Where the console reads Insights, and whether the server runs it. */
export interface ConsoleInsights {
  /** "off" when the server runs without `insights()`; a self-hosted server is asked. */
  status(): Promise<"on" | "off">;
  readonly reads: ConsoleInsightsReads;
  /** Usage and release activity: only a database the console opens itself serves them. */
  readonly model: InsightsModel | null;
}

export interface ConsoleRuntime {
  readonly insights: ConsoleInsights;
  /** API key management, or null when the console cannot manage keys here. */
  readonly apiKeys: ApiKeyManagementAPI | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasMethods = (value: unknown, methods: readonly string[]) =>
  isRecord(value) &&
  methods.every((method) => typeof value[method] === "function");

const off = async (): Promise<never> => {
  throw new InsightsOffError();
};

const insightsOff: ConsoleInsights = {
  status: async () => "off",
  reads: {
    getInstallation: off,
    getReportingOverview: off,
    listEvents: off,
    listInstallationEvents: off,
    pageInstallationsByCurrentUserId: off,
  },
  model: null,
};

const insightsOn = (model: InsightsModel): ConsoleInsights => ({
  status: async () => "on",
  reads: createInsightsProvider(model),
  model,
});

const toMetadata = ({ hash: _hash, ...record }: ApiKeyRow) => record;

/** The legacy database plugin's API key model, as the management API. */
const manageApiKeyModel = (model: ApiKeyModel): ApiKeyManagementAPI => ({
  create: ({ name }) => createApiKey({ apiKeys: model, name }),
  list: async () => (await model.list()).map(toMetadata),
  revoke: async ({ id }) => {
    const record = await model.revoke({ id, revokedAtMs: Date.now() });
    return record === null ? null : toMetadata(record);
  },
});

/**
 * Where Insights and API keys come from for a console config:
 * - a self-hosted server (`standaloneRepository`) runs its plugins, so the
 *   console reads Insights over its admin API and cannot manage keys;
 * - with `plugins`, the console assembles them over the database, as the
 *   server does, and a plugin that is not listed is off;
 * - without `plugins`, the database plugin serves both, until 1.0.
 */
export const createConsoleRuntime = (config: {
  readonly database: unknown;
  readonly plugins?: readonly unknown[];
}): ConsoleRuntime => {
  const { database, plugins } = config;
  if (isRecord(database) && typeof database.fetchAdmin === "function") {
    const admin = createAdminInsightsReads(database.fetchAdmin as FetchAdmin);
    return {
      insights: { status: admin.status, reads: admin.reads, model: null },
      apiKeys: null,
    };
  }
  if (plugins !== undefined) {
    const api = createDatabasePluginApis(database, plugins);
    return {
      insights:
        api.insights === undefined
          ? insightsOff
          : insightsOn(createInsightsModel(api.insights as InsightsApi)),
      apiKeys: hasMethods(api.apiKeys, ["create", "list", "revoke"])
        ? (api.apiKeys as ApiKeyManagementAPI)
        : null,
    };
  }
  const models = isRecord(database) ? database.models : undefined;
  const insights = isRecord(models) ? models.insights : undefined;
  const apiKeys = isRecord(models) ? models.apiKeys : undefined;
  return {
    insights: isRecord(insights)
      ? insightsOn(insights as unknown as InsightsModel)
      : insightsOff,
    apiKeys: hasMethods(apiKeys, ["create", "findByHash", "list", "revoke"])
      ? manageApiKeyModel(apiKeys as ApiKeyModel)
      : null,
  };
};

/** Insights usage and release activity, which a self-hosted server does not serve over its admin API. */
export const requireInsightsModel = async (
  insights: ConsoleInsights,
): Promise<InsightsModel> => {
  if (insights.model !== null) return insights.model;
  if ((await insights.status()) === "off") throw new InsightsOffError();
  throw new Error(
    "Insights usage and release activity are read from the database, and a self-hosted server does not serve them over its admin API.",
  );
};
