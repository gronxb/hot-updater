import type { HotUpdaterHttpMethod, HotUpdaterRouteAccess } from "./contracts";

export type CoreRouteDescriptor = {
  readonly access: HotUpdaterRouteAccess;
  readonly id: string;
  readonly method: HotUpdaterHttpMethod;
  readonly path: `/${string}`;
};

export type CoreRouteOptions = {
  readonly bundles?: false | true | { readonly access: HotUpdaterRouteAccess };
  readonly updateCheck?: boolean;
};

const publicAccess = Object.freeze({
  kind: "public",
}) satisfies HotUpdaterRouteAccess;
const protectedAccess = Object.freeze({
  kind: "protected",
}) satisfies HotUpdaterRouteAccess;

const versionRoute = {
  access: publicAccess,
  id: "core.version",
  method: "GET",
  path: "/version",
} as const satisfies CoreRouteDescriptor;

const updateRoutes = [
  {
    access: publicAccess,
    id: "core.update.fingerprint",
    method: "GET",
    path: "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId",
  },
  {
    access: publicAccess,
    id: "core.update.fingerprint-cohort",
    method: "GET",
    path: "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId/:cohort",
  },
  {
    access: publicAccess,
    id: "core.update.app-version",
    method: "GET",
    path: "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId",
  },
  {
    access: publicAccess,
    id: "core.update.app-version-cohort",
    method: "GET",
    path: "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId/:cohort",
  },
] as const satisfies readonly CoreRouteDescriptor[];

const bundleRoutes = [
  ["core.bundles.channels", "GET", "/api/bundles/channels"],
  ["core.bundles.get", "GET", "/api/bundles/:id"],
  ["core.bundles.list", "GET", "/api/bundles"],
  ["core.bundles.create", "POST", "/api/bundles"],
  ["core.bundles.update", "PATCH", "/api/bundles/:id"],
  ["core.bundles.delete", "DELETE", "/api/bundles/:id"],
] as const;

export const createCoreRouteDescriptors = (
  options: CoreRouteOptions = {},
): readonly CoreRouteDescriptor[] => {
  const routes: CoreRouteDescriptor[] = [Object.freeze(versionRoute)];
  if (options.updateCheck ?? true) {
    routes.push(...updateRoutes.map((route) => Object.freeze(route)));
  }
  if (options.bundles) {
    const access =
      options.bundles === true ? protectedAccess : options.bundles.access;
    const frozenAccess = Object.isFrozen(access)
      ? access
      : Object.freeze({ ...access });
    routes.push(
      ...bundleRoutes.map(([id, method, path]) =>
        Object.freeze({ access: frozenAccess, id, method, path }),
      ),
    );
  }
  return Object.freeze(routes);
};
