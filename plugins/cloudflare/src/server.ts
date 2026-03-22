import {
  type CreateHotUpdaterOptions,
  createHotUpdater,
  type HotUpdaterAPI,
} from "@hot-updater/server";
import { Hono } from "hono";

const DEFAULT_BASE_PATH = "/api/check-update";
const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"];

type CloudflareServerInput =
  | {
      hotUpdater: HotUpdaterAPI;
      basePath?: string;
    }
  | CreateHotUpdaterOptions;

const normalizeBasePath = (basePath: string) => {
  if (!basePath || basePath === "/") {
    return "/";
  }

  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
};

const wildcardPattern = (basePath: string) => {
  const normalized = normalizeBasePath(basePath);
  return normalized === "/" ? "/*" : `${normalized}/*`;
};

const resolveServerOptions = (options: CloudflareServerInput) => {
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

export function createCloudflareServerApp(options: CloudflareServerInput) {
  const { hotUpdater, basePath } = resolveServerOptions(options);
  const app = new Hono();

  app.on(HOT_UPDATER_METHODS, wildcardPattern(basePath), async (c) => {
    return hotUpdater.handler(c.req.raw);
  });

  return app;
}
