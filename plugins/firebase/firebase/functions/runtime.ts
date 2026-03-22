import {
  type createHotUpdater,
  rewriteLegacyExactRequestToCanonical,
  wildcardPattern,
} from "@hot-updater/server";
import type { HttpsFunction } from "firebase-functions/v2/https";
import { Hono } from "hono";
import { createFirebaseApp } from "./createFirebaseApp";

type HotUpdaterRuntime = Pick<
  ReturnType<typeof createHotUpdater>,
  "basePath" | "handler"
>;

export const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"];
export const HOT_UPDATER_BASE_PATH = "/api/check-update";

export interface CreateFirebaseFunctionsAppOptions {
  basePath?: string;
  getHotUpdater: (request: Request) => HotUpdaterRuntime;
}

export interface CreateFirebaseFunctionsHandlerOptions
  extends CreateFirebaseFunctionsAppOptions {
  region: string;
}

export const createFirebaseFunctionsApp = ({
  basePath = HOT_UPDATER_BASE_PATH,
  getHotUpdater,
}: CreateFirebaseFunctionsAppOptions) => {
  const app = new Hono();

  app.get("/ping", (c) => {
    return c.text("pong");
  });

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
    return getHotUpdater(c.req.raw).handler(c.req.raw);
  });

  return app;
};

export const createFirebaseFunctionsHandler = ({
  region,
  ...options
}: CreateFirebaseFunctionsHandlerOptions): HttpsFunction => {
  return createFirebaseApp({ region })(createFirebaseFunctionsApp(options));
};
