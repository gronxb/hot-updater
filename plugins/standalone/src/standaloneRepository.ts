import type {
  DatabaseImplementationResult,
  DatabaseModel,
  DatabasePluginImplementation,
  UpdateInfo,
} from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";

import {
  isPartialDatabaseRow,
  isUpdateInfo,
  requestStandaloneDatabase,
  StandaloneDatabaseError,
} from "./standaloneDatabaseProtocol";

export { StandaloneDatabaseError } from "./standaloneDatabaseProtocol";

export interface RouteConfig {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Routes {
  readonly database?: () => RouteConfig;
}

export interface StandaloneRepositoryConfig {
  readonly baseUrl: string;
  readonly commonHeaders?: Readonly<Record<string, string>>;
  readonly routes?: Routes;
  readonly getUpdateInfo?: boolean;
}

const DEFAULT_DATABASE_ROUTE = {
  path: "/api/database/v2",
  headers: { "Cache-Control": "no-cache" },
} as const satisfies RouteConfig;

const createRoute = (
  defaultRoute: RouteConfig,
  customRoute?: RouteConfig,
): RouteConfig => ({
  path: customRoute?.path ?? defaultRoute.path,
  headers: {
    ...defaultRoute.headers,
    ...customRoute?.headers,
  },
});

const parseRow = (
  model: DatabaseModel,
  value: unknown,
): DatabaseImplementationResult => {
  if (!isPartialDatabaseRow(model, value)) {
    throw new StandaloneDatabaseError(
      "invalid-response",
      `Invalid ${model} response row.`,
    );
  }
  return value;
};

const createImplementation = (
  config: StandaloneRepositoryConfig,
): DatabasePluginImplementation => {
  const route = createRoute(
    DEFAULT_DATABASE_ROUTE,
    config.routes?.database?.(),
  );
  const endpoint = `${config.baseUrl}${route.path}`;
  const headers = {
    "Content-Type": "application/json",
    ...config.commonHeaders,
    ...route.headers,
  };
  const request = (model: string, operation: string, input: unknown) =>
    requestStandaloneDatabase({ endpoint, headers, input, model, operation });

  return {
    async create(input) {
      const data = await request(input.model, "create", {
        data: input.data,
        ...(input.select ? { select: input.select } : {}),
      });
      return parseRow(input.model, data);
    },
    async update(input) {
      const data = await request("bundles", "update", {
        where: input.where,
        update: input.update,
        ...(input.select ? { select: input.select } : {}),
      });
      return data === null ? null : parseRow("bundles", data);
    },
    async delete(input) {
      const data = await request(input.model, "delete", {
        where: input.where,
      });
      if (data !== null) {
        throw new StandaloneDatabaseError(
          "invalid-response",
          "Delete response data must be null.",
        );
      }
    },
    async count(input) {
      const data = await request(
        "bundles",
        "count",
        input.where ? { where: input.where } : {},
      );
      if (!Number.isInteger(data) || typeof data !== "number" || data < 0) {
        throw new StandaloneDatabaseError(
          "invalid-response",
          "Count response data must be a non-negative integer.",
        );
      }
      return data;
    },
    async findOne(input) {
      const data = await request(input.model, "findOne", {
        ...(input.where ? { where: input.where } : {}),
        ...(input.select ? { select: input.select } : {}),
      });
      return data === null ? null : parseRow(input.model, data);
    },
    async findMany(input) {
      const data = await request(input.model, "findMany", {
        ...(input.where ? { where: input.where } : {}),
        limit: input.limit,
        offset: input.offset,
        ...(input.sortBy ? { sortBy: input.sortBy } : {}),
        ...(input.select ? { select: input.select } : {}),
      });
      if (!Array.isArray(data)) {
        throw new StandaloneDatabaseError(
          "invalid-response",
          "Find-many response data must be an array.",
        );
      }
      return data.map((row) => parseRow(input.model, row));
    },
    ...(config.getUpdateInfo
      ? {
          async getUpdateInfo(args) {
            const data = await request("bundles", "getUpdateInfo", args);
            if (data === null) return null;
            if (!isUpdateInfo(data)) {
              throw new StandaloneDatabaseError(
                "invalid-response",
                "Invalid update-info response.",
              );
            }
            return data satisfies UpdateInfo;
          },
        }
      : {}),
  };
};

export const standaloneRepository =
  createDatabasePlugin<StandaloneRepositoryConfig>({
    name: "standalone-repository",
    factory: createImplementation,
  });
