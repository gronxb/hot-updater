import {
  type createHotUpdater,
  normalizeBasePath,
  rewriteLegacyExactRequestToCanonical,
  wildcardPattern,
} from "@hot-updater/server/runtime";
import { Hono } from "hono";

type HotUpdaterRuntime = Pick<
  ReturnType<typeof createHotUpdater>,
  "basePath" | "handler"
>;

export const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"];
export const HOT_UPDATER_BASE_PATH = "/api/check-update";

export interface CreateSupabaseEdgeFunctionAppOptions {
  functionBasePath: string;
  basePath?: string;
  getHotUpdater: (request: Request) => HotUpdaterRuntime;
}

const stripFunctionBasePath = (request: Request, functionBasePath: string) => {
  const normalizedFunctionBasePath = normalizeBasePath(functionBasePath);

  if (normalizedFunctionBasePath === "/") {
    return request;
  }

  const url = new URL(request.url);

  if (!url.pathname.startsWith(normalizedFunctionBasePath)) {
    return request;
  }

  const nextPathname = url.pathname.slice(normalizedFunctionBasePath.length);
  url.pathname = nextPathname.startsWith("/")
    ? nextPathname
    : `/${nextPathname}`;

  return new Request(url, request);
};

export const createSupabaseEdgeFunctionApp = ({
  functionBasePath,
  basePath = HOT_UPDATER_BASE_PATH,
  getHotUpdater,
}: CreateSupabaseEdgeFunctionAppOptions) => {
  const app = new Hono().basePath(functionBasePath);

  app.get("/ping", (c) => c.text("pong"));

  app.get(basePath, async (c) => {
    const hotUpdater = getHotUpdater(c.req.raw);
    const rewrittenRequest = rewriteLegacyExactRequestToCanonical({
      basePath: hotUpdater.basePath,
      request: c.req.raw,
    });

    if (rewrittenRequest instanceof Response) {
      return rewrittenRequest;
    }

    return hotUpdater.handler(rewrittenRequest);
  });

  app.on(HOT_UPDATER_METHODS, wildcardPattern(basePath), async (c) => {
    const rewrittenRequest = stripFunctionBasePath(c.req.raw, functionBasePath);

    return getHotUpdater(rewrittenRequest).handler(rewrittenRequest);
  });

  return app;
};
