import type { ServerCoreApi } from "./core/api";

/** What the handlers run on: core's reads and typed writes. */
export interface HandlerAPI {
  readonly core: ServerCoreApi;
}

export type HotUpdaterHandler = (request: Request) => Promise<Response>;

export interface HotUpdaterHandlers {
  readonly client: HotUpdaterHandler;
  readonly admin: HotUpdaterHandler;
}

export type RouteHandler = (
  params: Record<string, string>,
  request: Request,
  api: HandlerAPI,
) => Promise<Response>;
