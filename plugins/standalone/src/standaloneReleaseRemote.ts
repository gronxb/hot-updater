import type {
  DatabaseCommit,
  DatabaseCommitResult,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";

import {
  createStandaloneHttp,
  StandaloneDatabaseError,
} from "./standaloneHttp";
import type { StandaloneRepositoryConfig } from "./standaloneRoutes";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const data = (value: unknown, message: string): unknown => {
  if (!isRecord(value) || !("data" in value)) {
    throw new StandaloneDatabaseError("invalid-response", message);
  }
  return value.data;
};

export const createStandaloneReleaseRemote = (
  config: StandaloneRepositoryConfig,
) => {
  const http = createStandaloneHttp(config);
  const headers = () => http.headers({ "Cache-Control": "no-cache" });

  return {
    async findReleaseById(id: string): Promise<ReleaseRow | null> {
      const response = await fetch(
        http.buildUrl(`/api/releases/${encodeURIComponent(id)}`),
        { headers: headers() },
      );
      if (response.status === 404) return null;
      return data(
        await http.parseJson(response),
        "Invalid Release response.",
      ) as ReleaseRow;
    },

    async findReleasesByScope(input: {
      readonly scopeKey: string;
      readonly afterReleaseId?: string;
      readonly limit: number;
    }): Promise<readonly ReleaseRow[]> {
      const url = new URL(http.buildUrl("/api/releases"));
      url.searchParams.set("scopeKey", input.scopeKey);
      url.searchParams.set("limit", String(input.limit));
      if (input.afterReleaseId !== undefined) {
        url.searchParams.set("afterReleaseId", input.afterReleaseId);
      }
      const response = await fetch(url, { headers: headers() });
      const rows = data(
        await http.parseJson(response),
        "Invalid Release list response.",
      );
      if (!Array.isArray(rows)) {
        throw new StandaloneDatabaseError(
          "invalid-response",
          "Invalid Release list response.",
          response.status,
        );
      }
      return rows as readonly ReleaseRow[];
    },

    async findReleases(input: {
      readonly beforeReleaseId?: string;
      readonly bundleId?: string;
      readonly channelId?: string;
      readonly enabled?: boolean;
      readonly platform?: "ios" | "android";
      readonly limit: number;
    }): Promise<readonly ReleaseRow[]> {
      const url = new URL(http.buildUrl("/api/releases"));
      url.searchParams.set("limit", String(input.limit));
      for (const [key, value] of Object.entries(input)) {
        if (key !== "limit" && value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
      const response = await fetch(url, { headers: headers() });
      const rows = data(
        await http.parseJson(response),
        "Invalid Release list response.",
      );
      if (!Array.isArray(rows)) {
        throw new StandaloneDatabaseError(
          "invalid-response",
          "Invalid Release list response.",
          response.status,
        );
      }
      return rows as readonly ReleaseRow[];
    },

    async findCatalogByScopeKey(
      scopeKey: string,
    ): Promise<ReleaseCatalogRow | null> {
      const response = await fetch(
        http.buildUrl(`/api/release-catalogs/${encodeURIComponent(scopeKey)}`),
        { headers: headers() },
      );
      if (response.status === 404) return null;
      return data(
        await http.parseJson(response),
        "Invalid Release catalog response.",
      ) as ReleaseCatalogRow;
    },

    async findCatalogs(input: {
      readonly afterScopeKey?: string;
      readonly limit: number;
    }): Promise<readonly ReleaseCatalogRow[]> {
      const url = new URL(http.buildUrl("/api/release-catalogs"));
      url.searchParams.set("limit", String(input.limit));
      if (input.afterScopeKey !== undefined) {
        url.searchParams.set("afterScopeKey", input.afterScopeKey);
      }
      const response = await fetch(url, { headers: headers() });
      const rows = data(
        await http.parseJson(response),
        "Invalid Release catalog list response.",
      );
      if (!Array.isArray(rows)) {
        throw new StandaloneDatabaseError(
          "invalid-response",
          "Invalid Release catalog list response.",
          response.status,
        );
      }
      return rows as readonly ReleaseCatalogRow[];
    },

    async commit(input: DatabaseCommit): Promise<DatabaseCommitResult> {
      const response = await fetch(http.buildUrl("/api/database/commit"), {
        body: JSON.stringify(input),
        headers: http.headers(),
        method: "POST",
      });
      return data(
        await http.parseJson(response),
        "Invalid database commit response.",
      ) as DatabaseCommitResult;
    },
  };
};
