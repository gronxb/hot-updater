import type {
  AppUpdateAvailableInfo,
  AppUpdateInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  Platform,
} from "@hot-updater/core";
import type {
  DatabaseBundleQueryOptions,
  HotUpdaterContext,
} from "@hot-updater/plugin-core";
import semver from "semver";

import type {
  BundleEventAnalyticsWindow,
  BundleEventAPI,
  CreateBundleEventRequest,
} from "./db/types";
import { supportsAnalytics } from "./db/types";
import { addRoute, createRouter, findRoute } from "./internalRouter";
import type { ChannelsResponse, PaginatedResult } from "./types";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

// Narrow API surface needed by the handler to avoid circular types
export interface HandlerAPI<TContext = unknown> extends Partial<
  BundleEventAPI<TContext>
> {
  getAppUpdateInfo: (
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<AppUpdateAvailableInfo | null>;
  getBundleById: (
    id: string,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Bundle | null>;
  getBundles: (
    options: DatabaseBundleQueryOptions,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<PaginatedResult>;
  insertBundle: (
    bundle: Bundle,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<void>;
  updateBundleById: (
    bundleId: string,
    bundle: Partial<Bundle>,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<void>;
  deleteBundleById: (
    bundleId: string,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<void>;
  getChannels: (context?: HotUpdaterContext<TContext>) => Promise<string[]>;
}

export interface HandlerOptions {
  /**
   * Base path for all routes
   * @default "/api"
   */
  basePath?: string;
  /**
   * Route groups to mount. Omit this option to use the default route groups.
   * When provided, both route groups must be specified explicitly.
   * The `/version` endpoint is always mounted for diagnostics.
   */
  routes?: HandlerRoutes;
}

export interface HandlerRoutes {
  /**
   * Controls whether update-check routes are mounted.
   * Defaults to `true` only when `routes` is omitted.
   */
  updateCheck: boolean;
  /**
   * Controls whether bundle management routes are mounted.
   * This includes `/api/bundles*`, which are used by the
   * CLI `standaloneRepository` adapter.
   * Defaults to `false` only when `routes` is omitted.
   */
  bundles: boolean;
}

type RouteHandler<TContext = unknown> = (
  params: Record<string, string>,
  request: Request,
  api: HandlerAPI<TContext>,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response>;

class HandlerBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandlerBadRequestError";
  }
}

class HandlerPayloadTooLargeError extends Error {
  constructor() {
    super("Event payload exceeds 16384 bytes");
    this.name = "HandlerPayloadTooLargeError";
  }
}

const SDK_VERSION_HEADER = "Hot-Updater-SDK-Version";
const EXPLICIT_NO_UPDATE_MIN_SDK_VERSION = "0.31.0";
const DEFAULT_BUNDLE_LIST_LIMIT = 50;
const MAX_BUNDLE_LIST_LIMIT = 100;
const DEFAULT_EVENT_LIST_LIMIT = 50;
const MAX_EVENT_LIST_LIMIT = 100;
const MAX_EVENT_BODY_BYTES = 16 * 1024;
const MAX_EVENT_STRING_LENGTH = 1024;

const supportsExplicitNoUpdateResponse = (request: Request) => {
  const sdkVersion = request.headers.get(SDK_VERSION_HEADER)?.trim();
  if (!sdkVersion) {
    return false;
  }

  const normalizedSdkVersion = semver.valid(sdkVersion);
  return (
    normalizedSdkVersion !== null &&
    semver.gte(normalizedSdkVersion, EXPLICIT_NO_UPDATE_MIN_SDK_VERSION)
  );
};

const serializeUpdateInfo = (
  updateInfo: AppUpdateAvailableInfo | null,
  request: Request,
): string => {
  if (updateInfo) {
    return JSON.stringify(updateInfo satisfies AppUpdateInfo);
  }

  if (supportsExplicitNoUpdateResponse(request)) {
    return JSON.stringify({ status: "UP_TO_DATE" } satisfies AppUpdateInfo);
  }

  return JSON.stringify(null);
};

// Route handlers
const handleVersion: RouteHandler = async () => {
  return new Response(JSON.stringify({ version: HOT_UPDATER_SERVER_VERSION }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const decodeMaybe = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const isPlatform = (value: string): value is Platform => {
  return value === "ios" || value === "android";
};

const requireRouteParam = (
  params: Record<string, string>,
  key: string,
): string => {
  const value = params[key];
  if (!value) {
    throw new HandlerBadRequestError(`Missing route parameter: ${key}`);
  }

  return value;
};

const parseBooleanSearchParam = (
  url: URL,
  key: string,
): boolean | undefined => {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new HandlerBadRequestError(
    `The '${key}' query parameter must be 'true' or 'false'.`,
  );
};

const parseNullableStringSearchParam = (
  url: URL,
  key: string,
): string | null | undefined => {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }

  return value === "null" ? null : value;
};

const parseStringArraySearchParam = (url: URL, key: string) => {
  const values = url.searchParams.getAll(key);
  return values.length > 0 ? values : undefined;
};

const parsePositiveIntegerSearchParam = (
  url: URL,
  key: string,
  defaultValue: number,
  maxValue: number,
): number => {
  const value = url.searchParams.get(key);
  if (value === null) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxValue) {
    throw new HandlerBadRequestError(
      `The '${key}' query parameter must be a positive integer between 1 and ${maxValue}.`,
    );
  }

  return parsed;
};

const parseNonNegativeIntegerSearchParam = (
  url: URL,
  key: string,
  defaultValue: number,
): number => {
  const value = url.searchParams.get(key);
  if (value === null) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HandlerBadRequestError(
      `The '${key}' query parameter must be a non-negative integer.`,
    );
  }

  return parsed;
};

const parseBundleEventAnalyticsWindow = (
  url: URL,
): BundleEventAnalyticsWindow => {
  const value = url.searchParams.get("window") ?? "24h";
  if (value === "24h" || value === "7d" || value === "30d" || value === "all") {
    return value;
  }

  throw new HandlerBadRequestError(
    "The 'window' query parameter must be one of '24h', '7d', '30d', or 'all'.",
  );
};

const requirePlatformParam = (params: Record<string, string>): Platform => {
  const platform = requireRouteParam(params, "platform");

  if (!isPlatform(platform)) {
    throw new HandlerBadRequestError(
      `Invalid platform: ${platform}. Expected 'ios' or 'android'.`,
    );
  }

  return platform;
};

type BundlePatchPayload = Partial<Bundle> & {
  id?: string;
};

const requireBundlePatchPayload = (
  payload: unknown,
  bundleId: string,
): Partial<Bundle> => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HandlerBadRequestError("Invalid bundle payload");
  }

  const bundlePatch = payload as BundlePatchPayload;
  if (bundlePatch.id !== undefined && bundlePatch.id !== bundleId) {
    throw new HandlerBadRequestError("Bundle id mismatch");
  }

  const { id: _ignoredId, ...rest } = bundlePatch;
  return rest;
};
const requireStringField = (
  payload: Record<string, unknown>,
  key: string,
): string => {
  const value = payload[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EVENT_STRING_LENGTH
  ) {
    throw new HandlerBadRequestError(`Invalid event field: ${key}`);
  }
  return value;
};

const requireNullableStringField = (
  payload: Record<string, unknown>,
  key: string,
): string | null => {
  const value = payload[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new HandlerBadRequestError(`Invalid event field: ${key}`);
  }
  if (value.length > MAX_EVENT_STRING_LENGTH) {
    throw new HandlerBadRequestError(`Invalid event field: ${key}`);
  }
  return value;
};

const readBundleEventBody = async (request: Request): Promise<unknown> => {
  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_EVENT_BODY_BYTES
  ) {
    throw new HandlerPayloadTooLargeError();
  }
  if (!request.body) {
    throw new HandlerBadRequestError("Invalid event payload");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > MAX_EVENT_BODY_BYTES) {
      await reader.cancel();
      throw new HandlerPayloadTooLargeError();
    }
    text += decoder.decode(result.value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HandlerBadRequestError("Invalid event payload");
    }
    throw error;
  }
};

const requireBundleEventPayload = (
  payload: unknown,
): CreateBundleEventRequest => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HandlerBadRequestError("Invalid event payload");
  }
  const record = payload as Record<string, unknown>;
  const type = requireStringField(record, "type");
  if (type !== "UPDATE_APPLIED" && type !== "RECOVERED") {
    throw new HandlerBadRequestError("Invalid event field: type");
  }
  const platform = requireStringField(record, "platform");
  if (!isPlatform(platform)) {
    throw new HandlerBadRequestError("Invalid event field: platform");
  }
  const updateStrategy = requireStringField(record, "updateStrategy");
  if (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion") {
    throw new HandlerBadRequestError("Invalid event field: updateStrategy");
  }
  return {
    type,
    installId: requireStringField(record, "installId"),
    fromBundleId: requireStringField(record, "fromBundleId"),
    toBundleId: requireStringField(record, "toBundleId"),
    ...(record.userId === undefined
      ? {}
      : { userId: requireStringField(record, "userId") }),
    ...(record.username === undefined
      ? {}
      : { username: requireStringField(record, "username") }),
    platform,
    appVersion: requireStringField(record, "appVersion"),
    channel: requireStringField(record, "channel"),
    cohort: requireStringField(record, "cohort"),
    updateStrategy,
    fingerprintHash: requireNullableStringField(record, "fingerprintHash"),
  };
};

const handleAppendBundleEvent: RouteHandler = async (
  _params,
  request,
  api,
  context,
) => {
  if (!supportsAnalytics(api)) {
    return new Response(null, { status: 404 });
  }
  const body = await readBundleEventBody(request);
  const payload = requireBundleEventPayload(body);
  const sdkVersionHeader = request.headers.get(SDK_VERSION_HEADER);
  const sdkVersion = sdkVersionHeader?.trim() ?? null;
  if (
    sdkVersion !== null &&
    (sdkVersion.length === 0 || sdkVersion.length > MAX_EVENT_STRING_LENGTH)
  ) {
    throw new HandlerBadRequestError("Invalid SDK version header");
  }
  const event: CreateBundleEventRequest & {
    readonly sdkVersion: string | null;
  } = {
    ...payload,
    sdkVersion,
  };
  await api.appendBundleEvent(event, context);
  return new Response(null, { status: 204 });
};

const handleFingerprintUpdateWithCohort: RouteHandler = async (
  params,
  request,
  api,
  context,
) => {
  const platform = requirePlatformParam(params);
  const fingerprintHash = requireRouteParam(params, "fingerprintHash");
  const channel = requireRouteParam(params, "channel");
  const minBundleId = requireRouteParam(params, "minBundleId");
  const bundleId = requireRouteParam(params, "bundleId");

  const updateInfo = await api.getAppUpdateInfo(
    {
      _updateStrategy: "fingerprint",
      platform,
      fingerprintHash,
      channel,
      minBundleId,
      bundleId,
      cohort: decodeMaybe(params.cohort),
    },
    context,
  );

  return new Response(serializeUpdateInfo(updateInfo, request), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleAppVersionUpdateWithCohort: RouteHandler = async (
  params,
  request,
  api,
  context,
) => {
  const platform = requirePlatformParam(params);
  const appVersion = requireRouteParam(params, "appVersion");
  const channel = requireRouteParam(params, "channel");
  const minBundleId = requireRouteParam(params, "minBundleId");
  const bundleId = requireRouteParam(params, "bundleId");

  const updateInfo = await api.getAppUpdateInfo(
    {
      _updateStrategy: "appVersion",
      platform,
      appVersion,
      channel,
      minBundleId,
      bundleId,
      cohort: decodeMaybe(params.cohort),
    },
    context,
  );

  return new Response(serializeUpdateInfo(updateInfo, request), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleGetBundle: RouteHandler = async (
  params,
  _request,
  api,
  context,
) => {
  const bundleId = requireRouteParam(params, "id");
  const bundle = await api.getBundleById(bundleId, context);

  if (!bundle) {
    return new Response(JSON.stringify({ error: "Bundle not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(bundle), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleGetBundles: RouteHandler = async (
  _params,
  request,
  api,
  context,
) => {
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel") ?? undefined;
  const platform = url.searchParams.get("platform");
  const limit = parsePositiveIntegerSearchParam(
    url,
    "limit",
    DEFAULT_BUNDLE_LIST_LIMIT,
    MAX_BUNDLE_LIST_LIMIT,
  );
  const pageParam = url.searchParams.get("page");
  const offset = url.searchParams.get("offset");
  const after = url.searchParams.get("after") ?? undefined;
  const before = url.searchParams.get("before") ?? undefined;
  const enabled = parseBooleanSearchParam(url, "enabled");
  const targetAppVersion = parseNullableStringSearchParam(
    url,
    "targetAppVersion",
  );
  const targetAppVersionIn = parseStringArraySearchParam(
    url,
    "targetAppVersionIn",
  );
  const targetAppVersionNotNull = parseBooleanSearchParam(
    url,
    "targetAppVersionNotNull",
  );
  const fingerprintHash = parseNullableStringSearchParam(
    url,
    "fingerprintHash",
  );
  const idEq = url.searchParams.get("idEq") ?? undefined;
  const idGt = url.searchParams.get("idGt") ?? undefined;
  const idGte = url.searchParams.get("idGte") ?? undefined;
  const idLt = url.searchParams.get("idLt") ?? undefined;
  const idLte = url.searchParams.get("idLte") ?? undefined;
  const idIn = parseStringArraySearchParam(url, "idIn");
  const page =
    pageParam === null
      ? undefined
      : Number.isInteger(Number(pageParam)) && Number(pageParam) > 0
        ? Number(pageParam)
        : null;

  if (offset !== null) {
    throw new HandlerBadRequestError(
      "The 'offset' query parameter has been removed. Use 'after' or 'before' cursor pagination instead.",
    );
  }

  if (page === null) {
    throw new HandlerBadRequestError(
      "The 'page' query parameter must be a positive integer.",
    );
  }

  if (platform !== null && !isPlatform(platform)) {
    throw new HandlerBadRequestError(
      `Invalid platform: ${platform}. Expected 'ios' or 'android'.`,
    );
  }

  const result = await api.getBundles(
    {
      where: {
        ...(channel && { channel }),
        ...(platform && { platform }),
        ...(enabled !== undefined && { enabled }),
        ...(idEq || idGt || idGte || idLt || idLte || (idIn && idIn.length > 0)
          ? {
              id: {
                ...(idEq && { eq: idEq }),
                ...(idGt && { gt: idGt }),
                ...(idGte && { gte: idGte }),
                ...(idLt && { lt: idLt }),
                ...(idLte && { lte: idLte }),
                ...(idIn && idIn.length > 0 && { in: idIn }),
              },
            }
          : {}),
        ...(targetAppVersion !== undefined && { targetAppVersion }),
        ...(targetAppVersionIn && { targetAppVersionIn }),
        ...(targetAppVersionNotNull !== undefined && {
          targetAppVersionNotNull,
        }),
        ...(fingerprintHash !== undefined && { fingerprintHash }),
      },
      limit,
      page,
      cursor:
        after || before
          ? {
              after,
              before,
            }
          : undefined,
    },
    context,
  );

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleCreateBundles: RouteHandler = async (
  _params,
  request,
  api,
  context,
) => {
  const body = await request.json();
  const bundles = Array.isArray(body) ? body : [body];

  for (const bundle of bundles) {
    await api.insertBundle(bundle as Bundle, context);
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
};

const handleUpdateBundle: RouteHandler = async (
  params,
  request,
  api,
  context,
) => {
  const bundleId = requireRouteParam(params, "id");
  const body = await request.json();
  const payload = Array.isArray(body) ? body[0] : body;
  const bundlePatch = requireBundlePatchPayload(payload, bundleId);
  await api.updateBundleById(bundleId, bundlePatch, context);

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleDeleteBundle: RouteHandler = async (
  params,
  _request,
  api,
  context,
) => {
  const bundleId = requireRouteParam(params, "id");
  await api.deleteBundleById(bundleId, context);

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleGetChannels: RouteHandler = async (
  _params,
  _request,
  api,
  context,
) => {
  const channels = await api.getChannels(context);
  const response: ChannelsResponse = {
    data: {
      channels,
    },
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleGetBundleEventSummary: RouteHandler = async (
  params,
  _request,
  api,
  context,
) => {
  if (!supportsAnalytics(api)) {
    return new Response(null, { status: 404 });
  }
  const result = await api.getBundleEventSummary(
    requireRouteParam(params, "id"),
    context,
  );
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleGetBundleEventAnalytics: RouteHandler = async (
  params,
  request,
  api,
  context,
) => {
  if (!supportsAnalytics(api)) {
    return new Response(null, { status: 404 });
  }
  const url = new URL(request.url);
  const result = await api.getBundleEventAnalytics(
    requireRouteParam(params, "id"),
    parseBundleEventAnalyticsWindow(url),
    parsePositiveIntegerSearchParam(
      url,
      "limit",
      DEFAULT_EVENT_LIST_LIMIT,
      MAX_EVENT_LIST_LIMIT,
    ),
    parseNonNegativeIntegerSearchParam(url, "offset", 0),
    context,
  );
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleGetBundleEventOverview: RouteHandler = async (
  _params,
  _request,
  api,
  context,
) => {
  if (!supportsAnalytics(api)) {
    return new Response(null, { status: 404 });
  }
  const result = await api.getBundleEventOverview(context);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleSearchInstallations: RouteHandler = async (
  _params,
  request,
  api,
  context,
) => {
  if (!supportsAnalytics(api)) {
    return new Response(null, { status: 404 });
  }
  const url = new URL(request.url);
  const result = await api.searchInstallations(
    url.searchParams.get("query")?.trim() ?? "",
    parsePositiveIntegerSearchParam(
      url,
      "limit",
      DEFAULT_EVENT_LIST_LIMIT,
      MAX_EVENT_LIST_LIMIT,
    ),
    parseNonNegativeIntegerSearchParam(url, "offset", 0),
    context,
  );
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleGetInstallationHistory: RouteHandler = async (
  params,
  request,
  api,
  context,
) => {
  if (!supportsAnalytics(api)) {
    return new Response(null, { status: 404 });
  }
  const url = new URL(request.url);
  const result = await api.getInstallationHistory(
    requireRouteParam(params, "installId"),
    parsePositiveIntegerSearchParam(
      url,
      "limit",
      DEFAULT_EVENT_LIST_LIMIT,
      MAX_EVENT_LIST_LIMIT,
    ),
    parseNonNegativeIntegerSearchParam(url, "offset", 0),
    context,
  );
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

// Route handlers map
const routes: Record<string, RouteHandler<any>> = {
  version: handleVersion,
  fingerprintUpdateWithCohort: handleFingerprintUpdateWithCohort,
  appVersionUpdateWithCohort: handleAppVersionUpdateWithCohort,
  getBundle: handleGetBundle,
  getBundles: handleGetBundles,
  createBundles: handleCreateBundles,
  updateBundle: handleUpdateBundle,
  deleteBundle: handleDeleteBundle,
  getChannels: handleGetChannels,
  appendBundleEvent: handleAppendBundleEvent,
  getBundleEventSummary: handleGetBundleEventSummary,
  getBundleEventAnalytics: handleGetBundleEventAnalytics,
  getBundleEventOverview: handleGetBundleEventOverview,
  searchInstallations: handleSearchInstallations,
  getInstallationHistory: handleGetInstallationHistory,
};

/**
 * Creates a Web Standard Request handler for Hot Updater API
 * This handler is framework-agnostic and works with any runtime that
 * supports standard Request/Response objects.
 */
export function createHandler<TContext = unknown>(
  api: HandlerAPI<TContext>,
  options: HandlerOptions = {},
): (
  request: Request,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response> {
  const basePath = options.basePath ?? "/api";
  const routeOptions = {
    updateCheck: options.routes?.updateCheck ?? true,
    bundles: options.routes?.bundles ?? false,
  };
  const analyticsRoutes = supportsAnalytics(api);

  // Create and configure router
  const router = createRouter();

  // Register routes
  addRoute(router, "GET", "/version", "version");

  if (routeOptions.updateCheck) {
    addRoute(
      router,
      "GET",
      "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId",
      "fingerprintUpdateWithCohort",
    );
    addRoute(
      router,
      "GET",
      "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId/:cohort",
      "fingerprintUpdateWithCohort",
    );
    addRoute(
      router,
      "GET",
      "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId",
      "appVersionUpdateWithCohort",
    );
    addRoute(
      router,
      "GET",
      "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId/:cohort",
      "appVersionUpdateWithCohort",
    );
    if (analyticsRoutes) {
      addRoute(router, "POST", "/events", "appendBundleEvent");
    }
  }

  if (routeOptions.bundles) {
    if (analyticsRoutes) {
      addRoute(
        router,
        "GET",
        "/api/bundles/:id/events/summary",
        "getBundleEventSummary",
      );
      addRoute(
        router,
        "GET",
        "/api/bundles/:id/events/analytics",
        "getBundleEventAnalytics",
      );
      addRoute(router, "GET", "/api/installations", "searchInstallations");
      addRoute(
        router,
        "GET",
        "/api/installations/overview",
        "getBundleEventOverview",
      );
      addRoute(
        router,
        "GET",
        "/api/installations/:installId/events",
        "getInstallationHistory",
      );
    }
    addRoute(router, "GET", "/api/bundles/channels", "getChannels");
    addRoute(router, "GET", "/api/bundles/:id", "getBundle");
    addRoute(router, "GET", "/api/bundles", "getBundles");
    addRoute(router, "POST", "/api/bundles", "createBundles");
    addRoute(router, "PATCH", "/api/bundles/:id", "updateBundle");
    addRoute(router, "DELETE", "/api/bundles/:id", "deleteBundle");
  }

  return async (
    request: Request,
    context?: HotUpdaterContext<TContext>,
  ): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // Remove base path from pathname
      const routePath = path.startsWith(basePath)
        ? path.slice(basePath.length)
        : path;

      // Find matching route
      const match = findRoute(router, method, routePath);

      if (!match) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const routeName = match.data as string;
      const handler = routes[routeName] as RouteHandler<TContext>;
      if (!handler) {
        return new Response(JSON.stringify({ error: "Handler not found" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      return await handler(match.params || {}, request, api, context);
    } catch (error) {
      if (error instanceof HandlerBadRequestError) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (error instanceof HandlerPayloadTooLargeError) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        });
      }

      console.error("Hot Updater handler error:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
}
