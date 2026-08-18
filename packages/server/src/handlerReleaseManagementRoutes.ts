import {
  ReleaseCatalogMutationError,
  ReleaseManagementError,
  type DatabaseCommit,
  type ReleasePolicyPatch,
} from "@hot-updater/plugin-core";

import { HandlerBadRequestError } from "./handlerErrors";
import { decodeMaybe, requireRouteParam } from "./handlerParameters";
import type { RouteHandler } from "./handlerTypes";

const unavailable = (): Response =>
  Response.json({ error: "Not found" }, { status: 404 });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseRevision = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new HandlerBadRequestError("Invalid expected Release revision");
  }
  return revision;
};

const parsePolicyInput = async (
  request: Request,
): Promise<{
  readonly expectedRevision?: number;
  readonly patch: ReleasePolicyPatch;
}> => {
  const body: unknown = await request.json();
  if (!isRecord(body) || !isRecord(body.patch)) {
    throw new HandlerBadRequestError("Invalid Release policy mutation");
  }
  return {
    expectedRevision: parseRevision(body.expectedRevision),
    patch: body.patch as ReleasePolicyPatch,
  };
};

const mutationResponse = async <T>(operation: () => Promise<T>) => {
  try {
    return Response.json({ data: await operation() });
  } catch (error) {
    if (
      error instanceof ReleaseManagementError ||
      error instanceof ReleaseCatalogMutationError
    ) {
      const status =
        error.code === "RELEASE_NOT_FOUND"
          ? 404
          : error.code === "VERSION_CONFLICT"
            ? 409
            : 400;
      return Response.json(
        { code: error.code, error: error.message },
        { status },
      );
    }
    throw error;
  }
};

export const createReleaseManagementRouteHandlers = (): Record<
  string,
  RouteHandler
> => ({
  getRelease: async (params, _request, api) => {
    if (api.getReleaseById === undefined) return unavailable();
    const row = await api.getReleaseById(requireRouteParam(params, "id"));
    return row === null
      ? unavailable()
      : Response.json({ data: row }, { status: 200 });
  },

  getReleases: async (_params, request, api) => {
    const url = new URL(request.url);
    const scopeKey = url.searchParams.get("scopeKey");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
      throw new HandlerBadRequestError("Invalid Release scope query");
    }
    if (scopeKey !== null) {
      if (scopeKey.length === 0 || api.getReleasesByScope === undefined) {
        throw new HandlerBadRequestError("Invalid Release scope query");
      }
      const afterReleaseId =
        url.searchParams.get("afterReleaseId") ?? undefined;
      return Response.json({
        data: await api.getReleasesByScope({
          ...(afterReleaseId === undefined ? {} : { afterReleaseId }),
          limit,
          scopeKey,
        }),
      });
    }
    if (api.getReleases === undefined) return unavailable();
    const enabledValue = url.searchParams.get("enabled");
    const enabled =
      enabledValue === null
        ? undefined
        : enabledValue === "true"
          ? true
          : enabledValue === "false"
            ? false
            : null;
    const platformValue = url.searchParams.get("platform");
    const platform =
      platformValue === null
        ? undefined
        : platformValue === "ios" || platformValue === "android"
          ? platformValue
          : null;
    if (enabled === null || platform === null) {
      throw new HandlerBadRequestError("Invalid Release list filter");
    }
    return Response.json({
      data: await api.getReleases({
        afterReleaseId: url.searchParams.get("afterReleaseId") ?? undefined,
        beforeReleaseId: url.searchParams.get("beforeReleaseId") ?? undefined,
        bundleId: url.searchParams.get("bundleId") ?? undefined,
        channelId: url.searchParams.get("channelId") ?? undefined,
        enabled,
        limit,
        platform,
        targetAppVersion: url.searchParams.get("targetAppVersion") ?? undefined,
      }),
    });
  },

  getReleaseCatalogRow: async (params, _request, api) => {
    if (api.getReleaseCatalogByScopeKey === undefined) return unavailable();
    const row = await api.getReleaseCatalogByScopeKey(
      decodeMaybe(requireRouteParam(params, "scopeKey")) ?? "",
    );
    return row === null
      ? unavailable()
      : Response.json({ data: row }, { status: 200 });
  },

  getReleaseCatalogs: async (_params, request, api) => {
    if (api.getReleaseCatalogs === undefined) return unavailable();
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "100");
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
      throw new HandlerBadRequestError("Invalid Release catalog list query");
    }
    return Response.json({
      data: await api.getReleaseCatalogs({
        afterScopeKey: url.searchParams.get("afterScopeKey") ?? undefined,
        limit,
      }),
    });
  },

  updateRelease: async (params, request, api) => {
    if (api.updateReleasePolicy === undefined) return unavailable();
    const input = await parsePolicyInput(request);
    return mutationResponse(() =>
      api.updateReleasePolicy!({
        ...input,
        releaseId: requireRouteParam(params, "id"),
      }),
    );
  },

  preflightRelease: async (params, request, api) => {
    if (api.preflightReleasePolicy === undefined) return unavailable();
    const input = await parsePolicyInput(request);
    return mutationResponse(() =>
      api.preflightReleasePolicy!({
        ...input,
        releaseId: requireRouteParam(params, "id"),
      }),
    );
  },

  deleteRelease: async (params, request, api) => {
    if (api.deleteRelease === undefined) return unavailable();
    const releaseId = requireRouteParam(params, "id");
    const url = new URL(request.url);
    if (url.searchParams.get("confirm") !== releaseId) {
      throw new HandlerBadRequestError(
        "Release hard deletion requires confirm=<release-id>",
      );
    }
    return mutationResponse(() =>
      api.deleteRelease!({
        expectedRevision: parseRevision(
          url.searchParams.get("expectedRevision"),
        ),
        releaseId,
      }),
    );
  },

  rebuildReleaseCatalog: async (params, _request, api) => {
    if (api.rebuildReleaseCatalog === undefined) return unavailable();
    return mutationResponse(() =>
      api.rebuildReleaseCatalog!(
        decodeMaybe(requireRouteParam(params, "scopeKey")) ?? "",
      ),
    );
  },

  commitDatabase: async (_params, request, api) => {
    if (api.commitDatabase === undefined) return unavailable();
    const input = (await request.json()) as DatabaseCommit;
    return Response.json({ data: await api.commitDatabase(input) });
  },
});
