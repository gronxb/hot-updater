import type { HotUpdaterInfrastructureRuntime } from "@hot-updater/plugin-core";

import { selectAuthenticationProvider } from "./authentication";
import {
  createCapabilityRegistry,
  type CapabilityRegistry,
} from "./capabilityRegistry";
import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterMatchedRoute,
  HotUpdaterRoutePolicy,
  HotUpdaterServerPlugin,
  HotUpdaterServerRoute,
} from "./contracts";
import { validatePluginContribution } from "./contributionValidation";
import { HotUpdaterConstructionError } from "./errors";
import {
  isFirstPartyServerPlugin,
  type FirstPartyServerPlugin,
} from "./manifest";
import { suppressNativePromiseRejection } from "./promise";
import { compileRoutes, type CompiledRouter } from "./routeCompiler";

export type ComposeServerKernelOptions = {
  readonly carriers: readonly object[];
  readonly coreRoutes: readonly HotUpdaterServerRoute[];
  readonly plugins: readonly HotUpdaterServerPlugin[];
  readonly runtime: HotUpdaterInfrastructureRuntime;
};

export type ComposedServerKernel = {
  readonly authentication?: HotUpdaterAuthenticationProvider;
  readonly capabilities: CapabilityRegistry;
  readonly router: CompiledRouter;
};

type CollectedRoute = {
  readonly origin: "core" | "plugin";
  readonly route: HotUpdaterServerRoute;
};

const invalidContribution = (pluginId: string): never => {
  throw new HotUpdaterConstructionError("INVALID_PLUGIN_CONTRIBUTION", {
    pluginId,
  });
};

const pluginId = (value: unknown): string => {
  if (typeof value !== "object" || value === null) return "<invalid>";
  try {
    const id = Reflect.get(value, "id");
    return typeof id === "string" && id.length > 0 ? id : "<invalid>";
  } catch {
    return "<invalid>";
  }
};

const validatePlugin = (value: unknown): FirstPartyServerPlugin => {
  const id = pluginId(value);
  try {
    if (
      !isFirstPartyServerPlugin(value) ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      typeof value.setup !== "function" ||
      !Array.isArray(value.requires) ||
      !value.requires.every(
        (requirement) =>
          (requirement.missing === "continue" ||
            requirement.missing === "error") &&
          typeof requirement.token === "object" &&
          requirement.token !== null &&
          typeof requirement.token.id === "string" &&
          typeof requirement.token.parse === "function",
      )
    ) {
      return invalidContribution(id);
    }
    return value;
  } catch (error) {
    if (error instanceof HotUpdaterConstructionError) throw error;
    return invalidContribution(pluginId(value));
  }
};

const rejectThenable = (value: unknown, id: string): void => {
  if (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    typeof Reflect.get(value, "then") === "function"
  ) {
    suppressNativePromiseRejection(value);
    invalidContribution(id);
  }
};

const matchedRoute = (route: HotUpdaterServerRoute): HotUpdaterMatchedRoute =>
  Object.freeze({
    access: Object.freeze({ ...route.access }),
    id: route.id,
    method: route.method,
    params: Object.freeze({}),
    pattern: route.path,
  });

const policyProtectsRoute = (
  policy: HotUpdaterRoutePolicy,
  route: CollectedRoute,
): boolean => {
  switch (policy.kind) {
    case "protect-all":
      return true;
    case "protect-except-core":
      return (
        route.origin === "plugin" || !policy.routeIds.includes(route.route.id)
      );
  }
};

const applyRoutePolicies = (
  routes: readonly CollectedRoute[],
  policies: readonly HotUpdaterRoutePolicy[],
): readonly HotUpdaterServerRoute[] =>
  routes.map((collectedRoute) => {
    const { route } = collectedRoute;
    if (
      route.access.kind === "protected" ||
      !policies.some((policy) => policyProtectsRoute(policy, collectedRoute))
    ) {
      return route;
    }
    return Object.freeze({
      ...route,
      access: Object.freeze({ kind: "protected" }),
    });
  });

export const composeServerKernel = (
  options: ComposeServerKernelOptions,
): ComposedServerKernel => {
  const plugins = options.plugins.map(validatePlugin);
  const pluginIds = new Set<string>();
  for (const plugin of plugins) {
    if (pluginIds.has(plugin.id)) {
      throw new HotUpdaterConstructionError("DUPLICATE_PLUGIN_ID", {
        pluginId: plugin.id,
      });
    }
    pluginIds.add(plugin.id);
  }
  plugins.sort((left, right) => left.id.localeCompare(right.id));

  const capabilities = createCapabilityRegistry({
    carriers: options.carriers,
    requiredTokens: plugins.flatMap((plugin) =>
      plugin.requires.map(({ token }) => token),
    ),
    runtime: options.runtime,
  });
  for (const plugin of plugins) {
    for (const requirement of plugin.requires) {
      if (
        requirement.missing === "error" &&
        !capabilities.has(requirement.token)
      ) {
        throw new HotUpdaterConstructionError("MISSING_CAPABILITY", {
          pluginId: plugin.id,
          tokenId: requirement.token.id,
        });
      }
    }
  }

  const routes: CollectedRoute[] = options.coreRoutes.map((route) => ({
    origin: "core",
    route,
  }));
  const authentication: HotUpdaterAuthenticationProvider[] = [];
  const routePolicies: HotUpdaterRoutePolicy[] = [];
  for (const plugin of plugins) {
    try {
      const setupResult = plugin.setup(
        Object.freeze({
          capabilities: capabilities.forPlugin(plugin.id),
          database: options.runtime.database,
        }),
      );
      rejectThenable(setupResult, plugin.id);
      const contribution = validatePluginContribution(setupResult);
      routes.push(
        ...contribution.routes.map(
          (route): CollectedRoute => ({ origin: "plugin", route }),
        ),
      );
      if (contribution.authentication !== undefined) {
        authentication.push(contribution.authentication);
      }
      if (contribution.routePolicy !== undefined) {
        routePolicies.push(contribution.routePolicy);
      }
    } catch (error) {
      if (error instanceof HotUpdaterConstructionError) throw error;
      invalidContribution(plugin.id);
    }
  }

  const router = compileRoutes(applyRoutePolicies(routes, routePolicies));
  const selectedAuthentication = selectAuthenticationProvider({
    providers: authentication,
    routes: router.routes.map(matchedRoute),
  });
  return Object.freeze({
    ...(selectedAuthentication === undefined
      ? {}
      : { authentication: selectedAuthentication }),
    capabilities,
    router,
  });
};
