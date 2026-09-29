import type { Bundle } from "@hot-updater/core";
import {
  DatabaseBundleNotFoundError,
  ReleaseCatalogMutationError,
  ReleaseManagementError,
  type Deployment,
  type KeysetInput,
  type ReleaseFilter,
  type ReleasePolicyPatch,
} from "@hot-updater/plugin-core";
import { DatabaseRowReferencedError } from "@hot-updater/plugin-core/internal";

import type { CoreApi } from "./core/api";
import { HandlerBadRequestError } from "./handlerErrors";
import {
  decodeMaybe,
  isPlatform,
  parseBooleanSearchParam,
  requireRouteParam,
} from "./handlerParameters";
import type { RouteHandler } from "./handlerTypes";

/**
 * The admin API's protocol, which `/version` reports. Protocol 2 pages by
 * key, lists releases by the filter sets their indexes serve, and writes
 * through core's typed operations. `v=2` on a request is accepted and
 * changes nothing: protocol 1 is gone.
 */
export const ADMIN_API_PROTOCOL = 2;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const notFound = () => json({ error: "Not found" }, 404);

const noContent = () => new Response(null, { status: 204 });

/** Runs `route` on core, answering its refusals. */
const onCore =
  (
    route: (
      core: CoreApi,
      request: Request,
      params: Record<string, string>,
    ) => Promise<Response>,
  ): RouteHandler =>
  async (params, request, api) =>
    answer(() => route(api.core, request, params));

/** Core's refusals as HTTP answers; anything else is a server error. */
export const answer = async (
  operation: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await operation();
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
      return json({ code: error.code, error: error.message }, status);
    }
    if (error instanceof DatabaseBundleNotFoundError) {
      return json({ code: "BUNDLE_NOT_FOUND", error: error.message }, 404);
    }
    if (error instanceof DatabaseRowReferencedError) {
      return json({ code: "REFERENCED", error: error.message }, 409);
    }
    throw error;
  }
};

const LIMITS = { defaultValue: 50, maxValue: 500 } as const;

/** `order`, `cursor`, and `limit`: one keyset page. */
const keyset = (url: URL, maxValue: number = LIMITS.maxValue): KeysetInput => {
  const order = url.searchParams.get("order") ?? "desc";
  if (order !== "asc" && order !== "desc") {
    throw new HandlerBadRequestError("order must be 'asc' or 'desc'.");
  }
  const limitParam = url.searchParams.get("limit");
  const limit =
    limitParam === null
      ? Math.min(LIMITS.defaultValue, maxValue)
      : Number(limitParam);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxValue) {
    throw new HandlerBadRequestError(
      `limit must be between 1 and ${maxValue}.`,
    );
  }
  const cursor = url.searchParams.get("cursor");
  return { order, limit, ...(cursor === null ? {} : { after: cursor }) };
};

/** A page and the cursor of the next one, when the page is full. */
const page = <T>(
  rows: readonly T[],
  { limit }: KeysetInput,
  keyOf: (row: T) => string,
  extra: Record<string, unknown> = {},
) =>
  json({
    data: rows,
    ...(rows.length === limit && rows.length > 0
      ? { next: keyOf(rows.at(-1)!) }
      : {}),
    ...extra,
  });

const platformOf = (url: URL) => {
  const platform = url.searchParams.get("platform");
  if (platform === null) return undefined;
  if (!isPlatform(platform)) {
    throw new HandlerBadRequestError(
      `Invalid platform: ${platform}. Expected 'ios' or 'android'.`,
    );
  }
  return platform;
};

/** The one filter set a release list names; any other mix of filters is refused. */
const releaseFilter = (url: URL): ReleaseFilter => {
  const params = url.searchParams;
  const named = ["channelId", "platform", "bundleId", "scopeKey"].filter(
    (name) => params.has(name),
  );
  const enabled = parseBooleanSearchParam(url, "enabled");
  const withEnabled = enabled === undefined ? {} : { enabled };
  const set = named.join(",");
  if (set === "" && enabled === undefined) return { kind: "all" };
  if (set === "channelId,platform") {
    const platform = platformOf(url)!;
    return {
      kind: "channelPlatform",
      channelId: params.get("channelId")!,
      platform,
      ...withEnabled,
    };
  }
  if (set === "bundleId" && enabled === undefined) {
    return { kind: "bundle", bundleId: params.get("bundleId")! };
  }
  if (set === "scopeKey") {
    return { kind: "scope", scopeKey: params.get("scopeKey")!, ...withEnabled };
  }
  throw new HandlerBadRequestError(
    "Releases filter by none, channelId and platform (with enabled), bundleId, or scopeKey (with enabled).",
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const body = async (request: Request): Promise<Record<string, unknown>> => {
  const value: unknown = await request.json();
  if (!isRecord(value)) throw new HandlerBadRequestError("Invalid body");
  return value;
};

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isTextOrNull = (value: unknown) => value === null || isText(value);

const isBundle = (bundle: unknown): boolean =>
  isRecord(bundle) &&
  isText(bundle.id) &&
  typeof bundle.platform === "string" &&
  isPlatform(bundle.platform) &&
  isTextOrNull(bundle.gitCommitHash) &&
  isText(bundle.manifestStorageUri) &&
  isText(bundle.manifestFileHash) &&
  isText(bundle.assetBaseStorageUri) &&
  (bundle.metadata === undefined || isRecord(bundle.metadata)) &&
  (bundle.patches === undefined ||
    bundle.patches === null ||
    Array.isArray(bundle.patches));

const isReleasePolicy = (release: unknown): boolean =>
  isRecord(release) &&
  isText(release.channel) &&
  typeof release.enabled === "boolean" &&
  typeof release.shouldForceUpdate === "boolean" &&
  isTextOrNull(release.fingerprintHash) &&
  isTextOrNull(release.targetAppVersion) &&
  (release.message === null || typeof release.message === "string") &&
  (release.rolloutCohortCount === undefined ||
    (Number.isSafeInteger(release.rolloutCohortCount) &&
      (release.rolloutCohortCount as number) >= 0 &&
      (release.rolloutCohortCount as number) <= 1000)) &&
  (release.targetCohorts === undefined ||
    (Array.isArray(release.targetCohorts) &&
      release.targetCohorts.every(isText)));

/** A deployment's shape: a new bundle or a stored bundle's id, and its release policy. */
const isDeployment = (value: unknown): value is Deployment =>
  isRecord(value) &&
  isReleasePolicy(value.release) &&
  ("bundleId" in value
    ? isText(value.bundleId) && !("bundle" in value)
    : isBundle(value.bundle));

/** An expected release revision from a body number or a query string. */
const revisionOf = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const revision = typeof value === "string" ? Number(value) : value;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new HandlerBadRequestError("Invalid expected Release revision");
  }
  return revision;
};

/** A policy change's body: `{ expectedRevision?, patch }`. */
const policyInput = async (request: Request) => {
  const input = await body(request);
  if (!isRecord(input.patch)) {
    throw new HandlerBadRequestError("Invalid Release policy mutation");
  }
  const expectedRevision = revisionOf(input.expectedRevision);
  return {
    patch: input.patch as ReleasePolicyPatch,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
};

type BundleUpdate = Parameters<CoreApi["updateBundle"]>[1];

/** A bundle update's body: the fields it changes, never another bundle's id. */
const bundleUpdateOf = (value: unknown, bundleId: string): BundleUpdate => {
  if (!isRecord(value))
    throw new HandlerBadRequestError("Invalid bundle payload");
  const { id, ...update } = value as Partial<Bundle>;
  if (id !== undefined && id !== bundleId) {
    throw new HandlerBadRequestError("Bundle id mismatch");
  }
  return update as BundleUpdate;
};

const scopeKeyOf = (params: Record<string, string>) =>
  decodeMaybe(requireRouteParam(params, "scopeKey")) ?? "";

/** Every admin route's handler, by the name `ADMIN_ROUTES` mounts it under. */
export const createAdminRouteHandlers = (): Record<string, RouteHandler> => ({
  listBundles: onCore(async (core, request) => {
    const url = new URL(request.url);
    const input = keyset(url, 100);
    const platform = platformOf(url);
    const withTotal = parseBooleanSearchParam(url, "total") === true;
    const [rows, total] = await Promise.all([
      core.listBundles({ ...input, ...(platform ? { platform } : {}) }),
      withTotal ? core.countBundles(platform) : undefined,
    ]);
    return page(
      rows,
      input,
      (row) => row.bundle.id,
      total === undefined ? {} : { total },
    );
  }),

  getBundle: onCore(async (core, _request, params) => {
    const detail = await core.getBundle(requireRouteParam(params, "id"));
    return detail === null ? notFound() : json({ data: detail });
  }),

  listReleases: onCore(async (core, request) => {
    const url = new URL(request.url);
    const input = keyset(url);
    const rows = await core.listReleases({
      ...input,
      filter: releaseFilter(url),
    });
    return page(rows, input, (row) => row.id);
  }),

  listReleaseCatalogs: onCore(async (core, request) => {
    const input = keyset(new URL(request.url));
    const rows = await core.listReleaseCatalogs(input);
    return page(rows, input, (row) => row.scope_key);
  }),

  /** With `name`, the one channel of that name: 1 read. */
  getChannels: onCore(async (core, request) => {
    const name = new URL(request.url).searchParams.get("name");
    if (name === null) return json({ data: await core.listChannels() });
    const channel = await core.findChannelByName(name);
    return channel === null ? notFound() : json({ data: channel });
  }),

  /** The channel named in the body, created when missing. */
  createChannel: onCore(async (core, request) => {
    const { name } = await body(request);
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new HandlerBadRequestError("Invalid channel name");
    }
    return json({ data: await core.ensureChannel(name) });
  }),

  /** 204 when deleted; 404 or 409 with the reason otherwise. */
  deleteChannel: onCore(async (core, _request, params) => {
    const result = await core.deleteChannel(
      decodeMaybe(requireRouteParam(params, "id")) ?? "",
    );
    if (result.deleted) return noContent();
    return json({ data: result }, result.reason === "not_found" ? 404 : 409);
  }),

  getRelease: onCore(async (core, _request, params) => {
    const row = await core.getRelease(requireRouteParam(params, "id"));
    return row === null ? notFound() : json({ data: row });
  }),

  updateRelease: onCore(async (core, request, params) =>
    json({
      data: await core.updateReleasePolicy({
        ...(await policyInput(request)),
        releaseId: requireRouteParam(params, "id"),
      }),
    }),
  ),

  preflightRelease: onCore(async (core, request, params) =>
    json({
      data: await core.preflightReleasePolicy({
        ...(await policyInput(request)),
        releaseId: requireRouteParam(params, "id"),
      }),
    }),
  ),

  /** Hard deletion names the release twice: in the path and as `confirm`. */
  deleteRelease: onCore(async (core, request, params) => {
    const releaseId = requireRouteParam(params, "id");
    const url = new URL(request.url);
    if (url.searchParams.get("confirm") !== releaseId) {
      throw new HandlerBadRequestError(
        "Release hard deletion requires confirm=<release-id>",
      );
    }
    const expectedRevision = revisionOf(
      url.searchParams.get("expectedRevision"),
    );
    return json({
      data: await core.deleteRelease({
        releaseId,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    });
  }),

  getReleaseCatalogRow: onCore(async (core, _request, params) => {
    const row = await core.getReleaseCatalogRow(scopeKeyOf(params));
    return row === null ? notFound() : json({ data: row });
  }),

  rebuildReleaseCatalog: onCore(async (core, _request, params) =>
    json({ data: await core.rebuildReleaseCatalog(scopeKeyOf(params)) }),
  ),

  updateBundle: onCore(async (core, request, params) => {
    const bundleId = requireRouteParam(params, "id");
    await core.updateBundle(
      bundleId,
      bundleUpdateOf(await request.json(), bundleId),
    );
    return noContent();
  }),

  listBundleChildren: onCore(async (core, request, params) => {
    const input = keyset(new URL(request.url));
    const rows = await core.listPatchesFromBase(
      requireRouteParam(params, "id"),
      input,
    );
    return page(rows, input, (row) => row.bundle_id);
  }),

  findBaseCandidates: onCore(async (core, request, params) => {
    const url = new URL(request.url);
    const before = url.searchParams.get("before");
    const limit = Number(url.searchParams.get("limit") ?? "3");
    if (
      before === null ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new HandlerBadRequestError(
        "Base candidates need before=<bundle id> and a limit between 1 and 100.",
      );
    }
    return json({
      data: await core.findBaseBundleIds(
        decodeMaybe(requireRouteParam(params, "candidateKey")) ?? "",
        before,
        limit,
      ),
    });
  }),

  deployReleases: onCore(async (core, request) => {
    const { deployments } = await body(request);
    if (
      !Array.isArray(deployments) ||
      deployments.length === 0 ||
      !deployments.every(isDeployment)
    ) {
      throw new HandlerBadRequestError(
        "Deploy needs deployments, each a bundle and its release policy.",
      );
    }
    return json({ data: await core.deploy(deployments) }, 201);
  }),

  promoteRelease: onCore(async (core, request, params) => {
    const input = await body(request);
    if (
      typeof input.targetChannel !== "string" ||
      (input.action !== undefined &&
        input.action !== "copy" &&
        input.action !== "move")
    ) {
      throw new HandlerBadRequestError("Invalid Release promotion");
    }
    const expectedRevision = revisionOf(input.expectedRevision);
    return json({
      data: await core.promoteRelease({
        releaseId: requireRouteParam(params, "id"),
        targetChannel: input.targetChannel,
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    });
  }),

  preflightReleaseCatalogRebuild: onCore(async (core, _request, params) =>
    json({
      data: await core.preflightReleaseCatalogRebuild(scopeKeyOf(params)),
    }),
  ),

  deleteBundles: onCore(async (core, request) => {
    const { ids } = await body(request);
    if (
      !Array.isArray(ids) ||
      !ids.every((id): id is string => typeof id === "string" && id.length > 0)
    ) {
      throw new HandlerBadRequestError("Bundle deletion needs ids");
    }
    await core.deleteBundles(ids);
    return noContent();
  }),
});

/** The admin mount's routes, by the handler that serves each. */
export const ADMIN_ROUTES: readonly {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
}[] = [
  { method: "POST", path: "/releases", handler: "deployReleases" },
  { method: "POST", path: "/releases/:id/promote", handler: "promoteRelease" },
  { method: "GET", path: "/releases/:id", handler: "getRelease" },
  { method: "GET", path: "/releases", handler: "listReleases" },
  { method: "PATCH", path: "/releases/:id", handler: "updateRelease" },
  {
    method: "POST",
    path: "/releases/:id/preflight",
    handler: "preflightRelease",
  },
  { method: "DELETE", path: "/releases/:id", handler: "deleteRelease" },
  {
    method: "GET",
    path: "/release-catalogs/:scopeKey",
    handler: "getReleaseCatalogRow",
  },
  { method: "GET", path: "/release-catalogs", handler: "listReleaseCatalogs" },
  {
    method: "POST",
    path: "/release-catalogs/:scopeKey/rebuild",
    handler: "rebuildReleaseCatalog",
  },
  {
    method: "POST",
    path: "/release-catalogs/:scopeKey/preflight",
    handler: "preflightReleaseCatalogRebuild",
  },
  { method: "GET", path: "/channels", handler: "getChannels" },
  { method: "POST", path: "/channels", handler: "createChannel" },
  { method: "DELETE", path: "/channels/:id", handler: "deleteChannel" },
  { method: "GET", path: "/bundles/:id", handler: "getBundle" },
  { method: "GET", path: "/bundles", handler: "listBundles" },
  { method: "PATCH", path: "/bundles/:id", handler: "updateBundle" },
  { method: "POST", path: "/bundles/delete", handler: "deleteBundles" },
  {
    method: "GET",
    path: "/bundles/:id/children",
    handler: "listBundleChildren",
  },
  {
    method: "GET",
    path: "/base-candidates/:candidateKey",
    handler: "findBaseCandidates",
  },
];
