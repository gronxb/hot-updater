import {
  type CreateHotUpdaterOptions,
  createCheckUpdateResponse,
  createHotUpdater,
  type HotUpdaterAPI,
} from "@hot-updater/server";
import { Hono } from "hono";

const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;

type SupabaseServerInput =
  | {
      hotUpdater: HotUpdaterAPI;
      basePath?: string;
      functionName?: string;
    }
  | (CreateHotUpdaterOptions & {
      functionName?: string;
    });

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

const resolveDefaultBasePath = (input: {
  basePath?: string;
  functionName?: string;
}) => {
  if (input.basePath) {
    return input.basePath;
  }

  return input.functionName ? `/${input.functionName}` : "/";
};

const resolveServerOptions = (options: SupabaseServerInput) => {
  const basePath = normalizeBasePath(resolveDefaultBasePath(options));

  if ("hotUpdater" in options) {
    return {
      hotUpdater: options.hotUpdater,
      basePath,
    };
  }

  return {
    hotUpdater: createHotUpdater({
      ...options,
      basePath,
    }),
    basePath,
  };
};

export function createSupabaseServerApp(options: SupabaseServerInput) {
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
