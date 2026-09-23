import {
  DatabaseBundleNotFoundError,
  ReleaseCatalogMutationError,
  ReleaseManagementError,
  type Deployment,
  type HotUpdaterCoreApi,
  type KeysetInput,
  type ReleaseFilter,
} from "@hot-updater/plugin-core";
import { DatabaseRowReferencedError } from "@hot-updater/plugin-core/internal";

import { HandlerBadRequestError } from "./handlerErrors";
import {
  decodeMaybe,
  isPlatform,
  parseBooleanSearchParam,
  requireRouteParam,
} from "./handlerParameters";
import type { HandlerAPI, RouteHandler } from "./handlerTypes";

/**
 * The admin API's protocol, which `/version` reports. Protocol 2 pages by
 * key, lists releases by the filter sets their indexes serve, and writes
 * through core's typed operations instead of raw commits.
 */
export const ADMIN_API_PROTOCOL = 2;

/** A request for protocol 2's shape on a path protocol 1 also serves. */
export const isAdminV2 = (request: Request): boolean =>
  new URL(request.url).searchParams.get("v") === String(ADMIN_API_PROTOCOL);

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const notFound = () => json({ error: "Not found" }, 404);

/** Runs `route` on core, or answers 404 when the database is not on the storage engine. */
const onCore =
  (
    route: (
      core: HotUpdaterCoreApi,
      request: Request,
      params: Record<string, string>,
    ) => Promise<Response>,
  ): RouteHandler =>
  async (params, request, api: HandlerAPI) =>
    api.core === undefined
      ? notFound()
      : answer(() => route(api.core!, request, params));

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

/** A deployment's shape: the fields core writes, with their types. */
const isDeployment = (value: unknown): value is Deployment => {
  if (!isRecord(value) || !isRecord(value.bundle) || !isRecord(value.release)) {
    return false;
  }
  const { bundle, release } = value;
  return (
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
      Array.isArray(bundle.patches)) &&
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
        release.targetCohorts.every(isText)))
  );
};

const revisionOf = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new HandlerBadRequestError("Invalid expected Release revision");
  }
  return value;
};

/** Protocol 2's reads on paths protocol 1 also serves. */
export const adminV2Reads = {
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
} satisfies Record<string, RouteHandler>;

/** Protocol 2's routes that protocol 1 does not have. */
export const createAdminV2RouteHandlers = (): Record<string, RouteHandler> => ({
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
      data: await core.preflightReleaseCatalogRebuild(
        decodeMaybe(requireRouteParam(params, "scopeKey")) ?? "",
      ),
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
    return new Response(null, { status: 204 });
  }),
});
