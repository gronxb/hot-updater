import {
  createHotUpdater,
  type CreateHotUpdaterOptions,
  type RuntimeHotUpdaterAPI,
} from "@hot-updater/server";

import { analytics } from "../analytics";
import type {
  AnalyticsAPI,
  AnalyticsFeatureAvailable,
  AnalyticsFeatureUnavailable,
} from "../api";
import { withAnalyticsProvider } from "../provider";

type LegacyRouteOptions = {
  readonly analytics?: boolean;
  readonly bundles: boolean;
  readonly updateCheck: boolean;
};

export type LegacyCreateHotUpdaterOptions<TContext = undefined> = Omit<
  CreateHotUpdaterOptions<TContext>,
  "coreRoutes" | "plugins"
> & {
  readonly routes?: LegacyRouteOptions;
};

type CoreLegacyOptions<TContext> = LegacyCreateHotUpdaterOptions<TContext> & {
  readonly routes?: LegacyRouteOptions & { readonly analytics?: false };
};

type AnalyticsLegacyOptions<TContext> =
  LegacyCreateHotUpdaterOptions<TContext> & {
    readonly routes: LegacyRouteOptions & { readonly analytics: true };
  };

type CoreLegacyRuntime<TContext> = RuntimeHotUpdaterAPI<TContext> & {
  readonly features: Readonly<Record<never, never>>;
};

type AnalyticsLegacyRuntime<TContext> = RuntimeHotUpdaterAPI<TContext> &
  (
    | (Readonly<AnalyticsAPI<TContext>> & {
        readonly features: Readonly<{
          readonly analytics: AnalyticsFeatureAvailable<TContext>;
        }>;
      })
    | {
        readonly features: Readonly<{
          readonly analytics: AnalyticsFeatureUnavailable;
        }>;
      }
  );

const createLegacyCoreRoutes = (
  routes: LegacyRouteOptions,
): NonNullable<CreateHotUpdaterOptions["coreRoutes"]> => ({
  bundles: routes.bundles ? { access: { kind: "public" } } : false,
  updateCheck: routes.updateCheck,
});

const createCoreLegacyRuntime = <TContext>(
  options: Omit<LegacyCreateHotUpdaterOptions<TContext>, "routes">,
  routes: LegacyRouteOptions,
): CoreLegacyRuntime<TContext> =>
  createHotUpdater<TContext, readonly []>({
    ...options,
    coreRoutes: createLegacyCoreRoutes(routes),
  });

const createAnalyticsLegacyRuntime = <TContext>(
  options: Omit<LegacyCreateHotUpdaterOptions<TContext>, "routes">,
  routes: LegacyRouteOptions,
): AnalyticsLegacyRuntime<TContext> => {
  const manifest = analytics({
    missingCapability: "warn",
    queryAccess: "public",
  });
  return createHotUpdater<TContext, readonly [typeof manifest]>({
    ...options,
    coreRoutes: createLegacyCoreRoutes(routes),
    database: withAnalyticsProvider(options.database),
    plugins: [manifest],
  });
};

export function createLegacyHotUpdater<TContext = undefined>(
  options: AnalyticsLegacyOptions<TContext>,
): AnalyticsLegacyRuntime<TContext>;
export function createLegacyHotUpdater<TContext = undefined>(
  options: CoreLegacyOptions<TContext>,
): CoreLegacyRuntime<TContext>;
export function createLegacyHotUpdater<TContext = undefined>(
  options: LegacyCreateHotUpdaterOptions<TContext>,
): CoreLegacyRuntime<TContext> | AnalyticsLegacyRuntime<TContext>;
export function createLegacyHotUpdater<TContext = undefined>(
  options: LegacyCreateHotUpdaterOptions<TContext>,
): CoreLegacyRuntime<TContext> | AnalyticsLegacyRuntime<TContext> {
  const { routes: configuredRoutes, ...coreOptions } = options;
  const routes: LegacyRouteOptions = configuredRoutes ?? {
    analytics: false,
    bundles: false,
    updateCheck: true,
  };
  return routes.analytics
    ? createAnalyticsLegacyRuntime(coreOptions, routes)
    : createCoreLegacyRuntime(coreOptions, routes);
}
