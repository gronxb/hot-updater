import type { HandlerRoutes } from "./handlerTypes";

export type UpdateRouteHandlerKey =
  | "version"
  | "fingerprintUpdateWithCohort"
  | "appVersionUpdateWithCohort";

export type BundleRouteHandlerKey =
  | "getChannels"
  | "getBundle"
  | "getBundles"
  | "createBundles"
  | "updateBundle"
  | "deleteBundle";

export type CoreRouteHandlerKey = UpdateRouteHandlerKey | BundleRouteHandlerKey;

type CoreRouteDescriptor = {
  readonly group: "always" | keyof HandlerRoutes;
  readonly handlerKey: CoreRouteHandlerKey;
  readonly id: string;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  readonly path: `/${string}`;
};

const descriptors = [
  {
    group: "always",
    handlerKey: "version",
    id: "core.version",
    method: "GET",
    path: "/version",
  },
  {
    group: "updateCheck",
    handlerKey: "fingerprintUpdateWithCohort",
    id: "core.update.fingerprint",
    method: "GET",
    path: "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId",
  },
  {
    group: "updateCheck",
    handlerKey: "fingerprintUpdateWithCohort",
    id: "core.update.fingerprint-cohort",
    method: "GET",
    path: "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId/:cohort",
  },
  {
    group: "updateCheck",
    handlerKey: "appVersionUpdateWithCohort",
    id: "core.update.app-version",
    method: "GET",
    path: "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId",
  },
  {
    group: "updateCheck",
    handlerKey: "appVersionUpdateWithCohort",
    id: "core.update.app-version-cohort",
    method: "GET",
    path: "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId/:cohort",
  },
  {
    group: "bundles",
    handlerKey: "getChannels",
    id: "core.bundles.channels",
    method: "GET",
    path: "/api/bundles/channels",
  },
  {
    group: "bundles",
    handlerKey: "getBundle",
    id: "core.bundles.get",
    method: "GET",
    path: "/api/bundles/:id",
  },
  {
    group: "bundles",
    handlerKey: "getBundles",
    id: "core.bundles.list",
    method: "GET",
    path: "/api/bundles",
  },
  {
    group: "bundles",
    handlerKey: "createBundles",
    id: "core.bundles.create",
    method: "POST",
    path: "/api/bundles",
  },
  {
    group: "bundles",
    handlerKey: "updateBundle",
    id: "core.bundles.update",
    method: "PATCH",
    path: "/api/bundles/:id",
  },
  {
    group: "bundles",
    handlerKey: "deleteBundle",
    id: "core.bundles.delete",
    method: "DELETE",
    path: "/api/bundles/:id",
  },
] as const satisfies readonly CoreRouteDescriptor[];

const coreRouteDescriptors = Object.freeze(
  descriptors.map((descriptor) => Object.freeze(descriptor)),
);

export function getCoreRouteDescriptors(
  routes?: HandlerRoutes,
): readonly CoreRouteDescriptor[] {
  const enabledGroups = {
    always: true,
    bundles: routes?.bundles ?? false,
    updateCheck: routes?.updateCheck ?? true,
  } satisfies Readonly<Record<CoreRouteDescriptor["group"], boolean>>;

  return Object.freeze(
    coreRouteDescriptors.filter(({ group }) => enabledGroups[group]),
  );
}
