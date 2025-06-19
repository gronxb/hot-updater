import { HotUpdater } from "./HotUpdater";
import type { NodePluginConfig, HotUpdaterHandler } from "./types";

export function createHandler(config: NodePluginConfig): HotUpdaterHandler {
  const hotUpdater = new HotUpdater({
    database: config.database,
    storage: config.storage
  });

  return hotUpdater.getHandler();
}

export function createRouteMatcher(basePath: string = "/update") {
  return (request: Request): boolean => {
    const url = new URL(request.url);
    return url.pathname === basePath && request.method === "GET";
  };
}