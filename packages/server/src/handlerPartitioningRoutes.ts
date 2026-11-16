import type { ServerCoreApi } from "./core/api";
import {
  ReleaseCatalogPartitioningError,
  ReleaseCatalogPartitioningRequestError,
} from "./core/catalogPartitioning";
import type { RouteHandler } from "./handlerTypes";

/**
 * The one path of release catalog partitioning, on both mounts. A server
 * before 1.2.0 answers 404 for it on either, for every method: no older
 * route has its shape.
 */
export const PARTITIONING_PATH = "/release-catalog-partitioning";

const NO_STORE = { "cache-control": "private, no-store" };

const answer = (body: unknown, status: number, headers = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

/** Turns partitioning on, or answers why the server refuses. */
const enable = async (
  core: ServerCoreApi,
  input: { readonly token?: string },
): Promise<Response> => {
  try {
    return answer(
      { data: await core.enableReleaseCatalogPartitioning(input) },
      200,
    );
  } catch (error) {
    if (error instanceof ReleaseCatalogPartitioningRequestError) {
      // Missing, expired, used and wrong tokens all answer this.
      return answer(
        { code: "PARTITIONING_REQUEST_INVALID", error: error.message },
        403,
      );
    }
    if (error instanceof ReleaseCatalogPartitioningError) {
      return error.code === "PARTITIONING_CONFLICT"
        ? answer({ code: error.code, error: error.message }, 503, {
            "retry-after": "1",
          })
        : answer({ code: error.code, error: error.message }, 409);
    }
    throw error;
  }
};

const tokenOf = async (request: Request): Promise<string> => {
  try {
    const body: unknown = await request.json();
    const token = (body as { readonly token?: unknown } | null)?.token;
    return typeof token === "string" && token.length > 0 ? token : "";
  } catch {
    return "";
  }
};

export const createPartitioningRouteHandlers = (): Record<
  string,
  RouteHandler
> => ({
  // Admin: the server's framework authenticates every request.
  getReleaseCatalogPartitioning: async (_params, _request, api) =>
    answer({ data: await api.core.getReleaseCatalogPartitioning() }, 200),
  enableReleaseCatalogPartitioning: async (_params, _request, api) =>
    enable(api.core, {}),
  // Client: public, for a managed server, which mounts no admin routes. Only
  // a request token stored with the database's own credentials opens it; an
  // empty token never matches one.
  requestReleaseCatalogPartitioning: async (_params, request, api) =>
    enable(api.core, { token: await tokenOf(request) }),
});
