import {
  type CreateHotUpdaterOptions,
  createCheckUpdateResponse,
  createHotUpdater,
  type HotUpdaterAPI,
} from "@hot-updater/server";
import { Hono } from "hono";
import { createFirebaseApp } from "../firebase/functions/createFirebaseApp";

const DEFAULT_BASE_PATH = "/api/check-update";
const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;

type FirebaseServerInput =
  | {
      hotUpdater: HotUpdaterAPI;
      basePath?: string;
    }
  | CreateHotUpdaterOptions;

export type CreateFirebaseServerOptions = FirebaseServerInput & {
  region: string;
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

const resolveServerOptions = (options: FirebaseServerInput) => {
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

export function createFirebaseServerApp(options: FirebaseServerInput) {
  const { hotUpdater, basePath } = resolveServerOptions(options);
  const app = new Hono();

  app.get(exactPattern(basePath), async (c) => {
    return createCheckUpdateResponse(hotUpdater, c.req.raw);
  });

  app.on(HOT_UPDATER_METHODS, wildcardPattern(basePath), async (c) => {
    return hotUpdater.handler(c.req.raw);
  });

  return app;
}

export function createFirebaseServer(options: CreateFirebaseServerOptions) {
  const { region, ...serverOptions } = options;
  return createFirebaseApp({ region })(createFirebaseServerApp(serverOptions));
}
