import type { RemoteDatabase } from "@hot-updater/plugin-core";
import {
  type RemoteConfigActive,
  type RemoteConfigApi,
  type RemoteConfigPublishResult,
  type RemoteConfigTemplateIssue,
  RemoteConfigValidationError,
  type RemoteConfigVersionDetail,
  type RemoteConfigVersionsPage,
} from "@hot-updater/server/plugins/remote-config";

import { ConsoleFeatureUnavailableError } from "../console-features";

/** How a publish from the console ended; `invalid` lists what to fix. */
export type ConsolePublishResult =
  | RemoteConfigPublishResult
  | {
      readonly status: "invalid";
      readonly issues: readonly RemoteConfigTemplateIssue[];
    };

/** The Remote Config the console pages use. */
export interface ConsoleRemoteConfig {
  getActive(): Promise<RemoteConfigActive>;
  listVersions(input: {
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<RemoteConfigVersionsPage>;
  getVersion(version: number): Promise<RemoteConfigVersionDetail | null>;
  publish(input: {
    readonly template: unknown;
    readonly baseVersion: number;
    readonly description?: string;
  }): Promise<ConsolePublishResult>;
  rollback(input: {
    readonly version: number;
    readonly baseVersion: number;
  }): Promise<ConsolePublishResult | { readonly status: "not_found" }>;
}

const invalidOf = (error: unknown): ConsolePublishResult => {
  if (error instanceof RemoteConfigValidationError) {
    return { status: "invalid", issues: error.issues };
  }
  throw error;
};

/** Remote Config over the `remoteConfig()` API the console assembled on the database. */
export const createLocalRemoteConfig = (
  api: RemoteConfigApi,
): ConsoleRemoteConfig => ({
  getActive: () => api.getActive(),
  listVersions: (input) => api.listVersions(input),
  getVersion: (version) => api.getVersion(version),
  publish: (input) => api.publish(input).catch(invalidOf),
  rollback: (input) => api.rollback(input),
});

const readBody = async (response: Response): Promise<unknown> =>
  response.json().catch(() => null);

const errorText = (body: unknown): string | undefined => {
  const error =
    typeof body === "object" && body !== null
      ? Reflect.get(body, "error")
      : undefined;
  return typeof error === "string" ? error : undefined;
};

/**
 * Remote Config over a self-hosted server's admin routes. A route the server
 * does not mount answers core's 404: it runs without `remoteConfig()`.
 */
export const createAdminRemoteConfig = (
  fetchAdmin: RemoteDatabase["fetchAdmin"],
): ConsoleRemoteConfig => {
  const unavailable = () =>
    new ConsoleFeatureUnavailableError("remoteConfig", { remote: true });
  const request = async (
    path: string,
    init?: { readonly method: string; readonly body: unknown },
  ): Promise<{ readonly status: number; readonly body: unknown }> => {
    const response = await fetchAdmin(
      path,
      init === undefined
        ? undefined
        : {
            method: init.method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(init.body),
          },
    );
    const body = await readBody(response);
    // Core's own 404 for a path no route matches.
    if (response.status === 404 && errorText(body) === "Not found") {
      throw unavailable();
    }
    return { status: response.status, body };
  };
  const expectOk = <T>(
    path: string,
    { status, body }: { status: number; body: unknown },
  ): T => {
    if (status >= 200 && status < 300) return body as T;
    throw new Error(
      errorText(body) ??
        `The server answered ${path.split("?")[0]} with ${status}.`,
    );
  };
  const published = (
    path: string,
    result: { status: number; body: unknown },
  ): ConsolePublishResult => {
    if (result.status === 409) {
      return {
        status: "conflict",
        currentVersion: Number(
          Reflect.get(result.body as object, "currentVersion"),
        ),
      };
    }
    if (result.status === 400) {
      const issues = Reflect.get(result.body as object, "issues");
      if (Array.isArray(issues)) return { status: "invalid", issues };
    }
    return {
      status: "published",
      version: expectOk(path, result),
    } as ConsolePublishResult;
  };

  return {
    getActive: async () => {
      const path = "/remote-config/template";
      return expectOk(path, await request(path));
    },
    listVersions: async ({ limit, cursor }) => {
      const query = new URLSearchParams();
      if (limit !== undefined) query.set("limit", String(limit));
      if (cursor !== undefined) query.set("cursor", cursor);
      const path = `/remote-config/versions${query.size === 0 ? "" : `?${query}`}`;
      return expectOk(path, await request(path));
    },
    getVersion: async (version) => {
      const path = `/remote-config/versions/${version}`;
      const result = await request(path);
      return result.status === 404 ? null : expectOk(path, result);
    },
    publish: async ({ template, baseVersion, description }) => {
      const path = "/remote-config/template";
      return published(
        path,
        await request(path, {
          method: "PUT",
          body: { template, baseVersion, description },
        }),
      );
    },
    rollback: async ({ version, baseVersion }) => {
      const path = `/remote-config/versions/${version}/rollback`;
      const result = await request(path, {
        method: "POST",
        body: { baseVersion },
      });
      return result.status === 404
        ? { status: "not_found" }
        : published(path, result);
    },
  };
};
