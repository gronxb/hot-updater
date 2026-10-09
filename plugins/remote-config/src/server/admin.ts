import type { RemoteDatabase } from "@hot-updater/plugin-core";

import type {
  RemoteConfigApi,
  RemoteConfigPublishResult,
  RemoteConfigVersion,
} from "./api";
import {
  type RemoteConfigTemplateIssue,
  RemoteConfigValidationError,
} from "./template";

/** What tooling edits templates with: `RemoteConfigApi` without the devices' `resolve`. */
export type RemoteConfigAdminApi = Omit<RemoteConfigApi, "resolve">;

export interface RemoteConfigAdminApiOptions {
  /**
   * The error for a server that runs without `remoteConfig()`, whose admin
   * API answers its routes with core's 404.
   */
  readonly unavailable?: () => Error;
}

const readBody = async (response: Response): Promise<unknown> =>
  response.json().catch(() => null);

const field = (body: unknown, name: string): unknown =>
  typeof body === "object" && body !== null
    ? Reflect.get(body, name)
    : undefined;

/** A published version's record, as a publish or a rollback answers it. */
const isPublishedVersion = (body: unknown): body is RemoteConfigVersion => {
  const version = field(body, "version");
  const updateType = field(body, "updateType");
  return (
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version > 0 &&
    (updateType === "PUBLISH" || updateType === "ROLLBACK") &&
    typeof field(body, "createdAtMs") === "number"
  );
};

const errorText = (body: unknown): string | undefined => {
  const error = field(body, "error");
  return typeof error === "string" ? error : undefined;
};

/**
 * Remote Config over a self-hosted server's admin routes, for tooling that
 * reaches it through `standaloneRepository`. It answers as the API does: an
 * invalid template throws `RemoteConfigValidationError` with the server's
 * issues.
 */
export const createRemoteConfigAdminApi = (
  fetchAdmin: RemoteDatabase["fetchAdmin"],
  {
    unavailable = () =>
      new Error(
        "The server runs without remoteConfig(): its admin API serves no Remote Config routes.",
      ),
  }: RemoteConfigAdminApiOptions = {},
): RemoteConfigAdminApi => {
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
  ): RemoteConfigPublishResult => {
    const currentVersion = field(result.body, "currentVersion");
    if (
      result.status === 409 &&
      typeof currentVersion === "number" &&
      Number.isSafeInteger(currentVersion)
    ) {
      return { status: "conflict", currentVersion };
    }
    const issues = field(result.body, "issues");
    if (result.status === 400 && Array.isArray(issues)) {
      throw new RemoteConfigValidationError(
        issues as RemoteConfigTemplateIssue[],
      );
    }
    const version = expectOk<unknown>(path, result);
    // Anything else, such as the active template a server that ignores the
    // method answers, published nothing.
    if (!isPublishedVersion(version)) {
      throw new Error(
        `The server answered ${path} without the version it published.`,
      );
    }
    return { status: "published", version };
  };

  return {
    getActive: async () => {
      const path = "/remote-config/template";
      return expectOk(path, await request(path));
    },
    listVersions: async ({ limit, cursor } = {}) => {
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
    rollback: async ({ version, baseVersion, description }) => {
      const path = `/remote-config/versions/${version}/rollback`;
      const result = await request(path, {
        method: "POST",
        body: { baseVersion, description },
      });
      return result.status === 404
        ? { status: "not_found" }
        : published(path, result);
    },
  };
};
