import {
  isDatabaseBusyError,
  type PluginEndpoint,
} from "@hot-updater/plugin-core";

import {
  REMOTE_CONFIG_PATH,
  REMOTE_CONFIG_QUERY,
  type RemoteConfigDeviceContext,
} from "../shared/wire";
import type { RemoteConfigApi } from "./api";
import {
  type RemoteConfigEvaluationContext,
  RemoteConfigValidationError,
} from "./template";

/** Seconds a client waits before it resends a request the busy database refused. */
const RETRY_AFTER_SECONDS = 5;
/** A shared cache keeps a device's values five seconds, as it keeps a Release Catalog. */
const FETCH_CACHE_CONTROL = "public, max-age=0, s-maxage=5";
const MAX_CONTEXT_LENGTH = 128;

class BadRequestError extends Error {}

const json = (
  body: unknown,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): Response =>
  Response.json(body, {
    headers: { "cache-control": "private, no-store", ...headers },
    status,
  });

const run = async (operation: () => Promise<Response>): Promise<Response> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RemoteConfigValidationError) {
      return json({ error: error.message, issues: error.issues }, 400);
    }
    if (error instanceof BadRequestError || error instanceof TypeError) {
      return json({ error: error.message }, 400);
    }
    if (isDatabaseBusyError(error)) {
      console.warn(
        "[hot-updater] Remote Config answered 503: the database is busy.",
        error,
      );
      return json({ error: "Service unavailable" }, 503, {
        "retry-after": String(RETRY_AFTER_SECONDS),
      });
    }
    throw error;
  }
};

const readContext = (request: Request): RemoteConfigEvaluationContext => {
  const query = new URL(request.url).searchParams;
  const read = (field: keyof RemoteConfigDeviceContext): string | null => {
    const value = query.get(REMOTE_CONFIG_QUERY[field]);
    if (value === null || value.length === 0) return null;
    if (value.length > MAX_CONTEXT_LENGTH) {
      throw new BadRequestError(`${field} is too long.`);
    }
    return value;
  };
  const platform = read("platform");
  if (platform !== null && platform !== "ios" && platform !== "android") {
    throw new BadRequestError('platform must be "ios" or "android".');
  }
  return {
    platform,
    appVersion: read("appVersion"),
    channel: read("channel"),
    cohort: read("cohort"),
    fingerprintHash: read("fingerprintHash"),
  };
};

const bodyHash = async (body: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const readJsonBody = async (
  request: Request,
): Promise<Record<string, unknown>> => {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
};

const versionParam = (params: Readonly<Record<string, string>>): number => {
  const text = params.version ?? "";
  if (!/^\d{1,15}$/u.test(text)) {
    throw new BadRequestError("The version must be a positive integer.");
  }
  return Number(text);
};

const publishResponse = (
  result: Awaited<ReturnType<RemoteConfigApi["publish"]>>,
): Response =>
  result.status === "published"
    ? json(result.version, 200)
    : json(
        {
          error: `Version ${result.currentVersion} was published since; reload the template and publish again.`,
          currentVersion: result.currentVersion,
        },
        409,
      );

/**
 * Remote Config's routes: the devices' `GET /remote-config` on
 * `handlers.client`, and template management on `handlers.admin`.
 */
export const createRemoteConfigEndpoints = (
  api: RemoteConfigApi,
): readonly PluginEndpoint[] => [
  {
    method: "GET",
    path: `/${REMOTE_CONFIG_PATH}`,
    access: "client",
    handler: (request) =>
      run(async () => {
        const body = JSON.stringify(await api.resolve(readContext(request)));
        const etag = `"sha256:${await bodyHash(body)}"`;
        const headers = {
          "cache-control": FETCH_CACHE_CONTROL,
          "content-type": "application/json",
          etag,
          vary: "Accept-Encoding",
        };
        if (request.headers.get("if-none-match") === etag) {
          return new Response(null, { headers, status: 304 });
        }
        return new Response(body, { headers, status: 200 });
      }),
  },
  {
    method: "GET",
    path: `/${REMOTE_CONFIG_PATH}/template`,
    access: "admin",
    handler: () => run(async () => json(await api.getActive(), 200)),
  },
  {
    method: "PUT",
    path: `/${REMOTE_CONFIG_PATH}/template`,
    access: "admin",
    handler: (request) =>
      run(async () => {
        const body = await readJsonBody(request);
        return publishResponse(
          await api.publish({
            template: body.template,
            baseVersion: body.baseVersion as number,
            ...(body.description === undefined
              ? {}
              : { description: body.description as string }),
          }),
        );
      }),
  },
  {
    method: "GET",
    path: `/${REMOTE_CONFIG_PATH}/versions`,
    access: "admin",
    handler: (request) =>
      run(async () => {
        const query = new URL(request.url).searchParams;
        const limit = query.get("limit");
        const cursor = query.get("cursor");
        return json(
          await api.listVersions({
            ...(limit === null ? {} : { limit: Number(limit) }),
            ...(cursor === null ? {} : { cursor }),
          }),
          200,
        );
      }),
  },
  {
    method: "GET",
    path: `/${REMOTE_CONFIG_PATH}/versions/:version`,
    access: "admin",
    handler: (_request, params) =>
      run(async () => {
        const version = await api.getVersion(versionParam(params));
        return version === null
          ? json({ error: "Version not found" }, 404)
          : json(version, 200);
      }),
  },
  {
    method: "POST",
    path: `/${REMOTE_CONFIG_PATH}/versions/:version/rollback`,
    access: "admin",
    handler: (request, params) =>
      run(async () => {
        const body = await readJsonBody(request);
        const result = await api.rollback({
          version: versionParam(params),
          baseVersion: body.baseVersion as number,
          ...(body.description === undefined
            ? {}
            : { description: body.description as string }),
        });
        return result.status === "not_found"
          ? json({ error: "Version not found" }, 404)
          : publishResponse(result);
      }),
  },
];
