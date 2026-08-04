import type { HotUpdaterContext } from "@hot-updater/plugin-core";

import type { HandlerRoutes } from "../handler";
import type {
  HotUpdaterHttpMethod,
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

const updateRoutes = [
  [
    "core.update.fingerprint",
    "GET",
    "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId",
  ],
  [
    "core.update.fingerprint-cohort",
    "GET",
    "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId/:cohort",
  ],
  [
    "core.update.app-version",
    "GET",
    "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId",
  ],
  [
    "core.update.app-version-cohort",
    "GET",
    "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId/:cohort",
  ],
] as const;

const bundleRoutes = [
  ["core.bundles.channels", "GET", "/api/bundles/channels"],
  ["core.bundles.get", "GET", "/api/bundles/:id"],
  ["core.bundles.list", "GET", "/api/bundles"],
  ["core.bundles.create", "POST", "/api/bundles"],
  ["core.bundles.update", "PATCH", "/api/bundles/:id"],
  ["core.bundles.delete", "DELETE", "/api/bundles/:id"],
] as const;

export function createCoreServerRoutes<TContext = unknown>(
  options: CreateCoreServerRoutesOptions<TContext>,
): readonly HotUpdaterServerRoute<Request, TContext>[] {
  const descriptors: Array<
    readonly [string, HotUpdaterHttpMethod, `/${string}`]
  > = [["core.version", "GET", "/version"]];
  if (options.routes?.updateCheck ?? true) {
    descriptors.push(...updateRoutes);
  }
  if (options.routes?.bundles ?? false) {
    descriptors.push(...bundleRoutes);
  }
  const input = Object.freeze({
    async parse(request: Request): Promise<Request> {
      return request;
    },
  });
  return Object.freeze(
    descriptors.map(([id, method, path]) =>
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
