import type { HotUpdaterContext } from "@hot-updater/plugin-core";

import { getCoreRouteDescriptors } from "../coreRouteDescriptors";
import type { HandlerRoutes } from "../handler";
import type {
  HotUpdaterRouteContext,
  HotUpdaterServerRoute,
} from "./contracts";

type LegacyHandler<TContext> = (
  request: Request,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response>;

export type CreateCoreServerRoutesOptions<TContext> = {
  readonly handler: LegacyHandler<TContext>;
  readonly routes?: HandlerRoutes;
};

const publicAccess = Object.freeze({ kind: "public" } as const);

export function createCoreServerRoutes<TContext = unknown>(
  options: CreateCoreServerRoutesOptions<TContext>,
): readonly HotUpdaterServerRoute<Request, TContext>[] {
  const input = Object.freeze({
    async parse(request: Request): Promise<Request> {
      return request;
    },
  });
  return Object.freeze(
    getCoreRouteDescriptors(options.routes).map(({ id, method, path }) =>
      Object.freeze({
        access: publicAccess,
        id,
        input,
        method,
        path,
        async handle(
          context: HotUpdaterRouteContext<TContext>,
          request: Request,
        ) {
          return options.handler(request, context.platformContext);
        },
      }),
    ),
  );
}
