import {
  type CreateHotUpdaterOptions,
  createCheckUpdateResponse,
  createHotUpdater,
  type HotUpdaterAPI,
} from "@hot-updater/server";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { Hono } from "hono";
import { handle } from "hono/lambda-edge";
import {
  NO_STORE_CACHE_CONTROL,
  SHARED_EDGE_CACHE_CONTROL,
} from "../lambda/cacheControl";

const DEFAULT_BASE_PATH = "/api/check-update";
const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"];

type AwsServerInput =
  | {
      hotUpdater: HotUpdaterAPI;
      basePath?: string;
    }
  | CreateHotUpdaterOptions;

export type CreateAwsLambdaEdgeServerOptions = AwsServerInput & {
  legacyCacheControl?: string;
  updateCacheControl?: string;
};

const normalizeBasePath = (basePath: string) => {
  if (!basePath || basePath === "/") {
    return "/";
  }

  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
};

const exactPattern = (basePath: string) => normalizeBasePath(basePath);

const wildcardPattern = (basePath: string) => {
  const normalized = normalizeBasePath(basePath);
  return normalized === "/" ? "/*" : `${normalized}/*`;
};

const resolveServerOptions = (options: AwsServerInput) => {
  if ("hotUpdater" in options) {
    return {
      hotUpdater: options.hotUpdater,
      basePath: normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH),
    };
  }

  const basePath = normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH);

  return {
    hotUpdater: createHotUpdater({
      ...options,
      basePath,
    }),
    basePath,
  };
};

const isCachedUpdateRoute = (basePath: string, path: string) => {
  const normalized = normalizeBasePath(basePath);
  const appVersionPrefix =
    normalized === "/" ? "/app-version/" : `${normalized}/app-version/`;
  const fingerprintPrefix =
    normalized === "/" ? "/fingerprint/" : `${normalized}/fingerprint/`;

  return (
    path.startsWith(appVersionPrefix) || path.startsWith(fingerprintPrefix)
  );
};

export function createAwsLambdaEdgeServerApp(
  options: CreateAwsLambdaEdgeServerOptions,
) {
  const {
    legacyCacheControl = NO_STORE_CACHE_CONTROL,
    updateCacheControl = SHARED_EDGE_CACHE_CONTROL,
    ...serverOptions
  } = options;
  const { hotUpdater, basePath } = resolveServerOptions(serverOptions);
  const app = new Hono();

  app.get(exactPattern(basePath), async (c) => {
    const response = await createCheckUpdateResponse(hotUpdater, c.req.raw);
    response.headers.set("Cache-Control", legacyCacheControl);
    return response;
  });

  app.on(HOT_UPDATER_METHODS, wildcardPattern(basePath), async (c) => {
    const response = await hotUpdater.handler(c.req.raw);

    if (c.req.method === "GET" && isCachedUpdateRoute(basePath, c.req.path)) {
      response.headers.set("Cache-Control", updateCacheControl);
    }

    return response;
  });

  return app;
}

export function createAwsLambdaEdgeServer(
  options: CreateAwsLambdaEdgeServerOptions,
): CloudFrontRequestHandler {
  return handle(
    createAwsLambdaEdgeServerApp(options),
  ) as CloudFrontRequestHandler;
}
