import type { HotUpdaterInfrastructureRuntime } from "@hot-updater/plugin-core";

import {
  projectFeatureApis,
  type ProjectedFeatureApis,
  type ProjectPlugins,
  type RuntimeFeatureApiContribution,
} from "./apiProjection";
import { selectAuthenticationProvider } from "./authentication";
import {
  createCapabilityRegistry,
  type CapabilityRegistry,
} from "./capabilityRegistry";
import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterMatchedRoute,
  HotUpdaterPostAuthMiddleware,
  HotUpdaterServerRoute,
  HotUpdaterVersionMetadataContribution,
} from "./contracts";
import { validatePluginContribution } from "./contributionValidation";
import { HotUpdaterConstructionError } from "./errors";
import {
  type FirstPartyFeatureManifest,
  type HotUpdaterConstructionDiagnostic,
} from "./manifest";
import {
  validateManifestIdentity,
  validateReadableManifest,
} from "./manifestValidation";
import {
  compileVersionMetadata,
  type CompiledVersionMetadata,
} from "./metadata";
import { compilePostAuthMiddleware } from "./middlewareDag";
import { compileRoutes, type CompiledRouter } from "./routeCompiler";

export type FeatureApiFromPlugins<
  TPlugins extends readonly FirstPartyFeatureManifest[],
  TContext,
> = ProjectPlugins<TPlugins, TContext>;

export type ComposeServerKernelOptions = {
  readonly carriers: readonly object[];
  readonly coreApiKeys?: readonly string[];
  readonly coreRoutes?: readonly HotUpdaterServerRoute[];
  readonly manifests: readonly FirstPartyFeatureManifest[];
  readonly reservedMetadataKeys?: readonly string[];
  readonly runtime: HotUpdaterInfrastructureRuntime;
};

export type ComposedServerKernel = {
  readonly api: ProjectedFeatureApis;
  readonly authentication?: HotUpdaterAuthenticationProvider;
  readonly capabilities: CapabilityRegistry;
  readonly diagnostics: readonly HotUpdaterConstructionDiagnostic[];
  readonly metadata: CompiledVersionMetadata;
  readonly middleware: readonly HotUpdaterPostAuthMiddleware[];
  readonly router: CompiledRouter;
};

const invalidContribution = (pluginId: string): never => {
  throw new HotUpdaterConstructionError("INVALID_PLUGIN_CONTRIBUTION", {
    pluginId,
  });
};

const isThenable = (value: unknown): boolean => {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return false;
  }
  return typeof Reflect.get(value, "then") === "function";
};

const matchedRoute = (route: HotUpdaterServerRoute): HotUpdaterMatchedRoute =>
  Object.freeze({
    access: Object.freeze({ ...route.access }),
    id: route.id,
    method: route.method,
    params: Object.freeze({}),
    pattern: route.path,
  });

export const composeServerKernel = (
  options: ComposeServerKernelOptions,
): ComposedServerKernel => {
  const readableManifests = options.manifests.map(validateReadableManifest);
  const capabilities = createCapabilityRegistry({
    carriers: options.carriers,
    requiredTokens: readableManifests.flatMap((manifest) =>
      manifest.requires.map(({ token }) => token),
    ),
    runtime: options.runtime,
  });

  const pluginIds = new Set<string>();
  for (const manifest of readableManifests) {
    validateManifestIdentity(manifest);
    if (pluginIds.has(manifest.id)) {
      throw new HotUpdaterConstructionError("DUPLICATE_PLUGIN_ID", {
        pluginId: manifest.id,
      });
    }
    pluginIds.add(manifest.id);
  }
  const manifests = [...readableManifests].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  for (const manifest of manifests) {
    for (const requirement of manifest.requires) {
      if (
        requirement.missing === "error" &&
        !capabilities.has(requirement.token)
      ) {
        throw new HotUpdaterConstructionError("MISSING_CAPABILITY", {
          pluginId: manifest.id,
          tokenId: requirement.token.id,
        });
      }
    }
  }

  const diagnostics: HotUpdaterConstructionDiagnostic[] = [];
  const warnedPluginIds = new Set<string>();
  const routes: HotUpdaterServerRoute[] = [...(options.coreRoutes ?? [])];
  const middleware: HotUpdaterPostAuthMiddleware[] = [];
  const metadata: HotUpdaterVersionMetadataContribution[] = [];
  const api: RuntimeFeatureApiContribution[] = [];
  const authentication: HotUpdaterAuthenticationProvider[] = [];

  for (const manifest of manifests) {
    try {
      const setupResult = manifest.setup({
        capabilities: capabilities.forPlugin(manifest.id),
        diagnostics: Object.freeze({
          warn(diagnostic: HotUpdaterConstructionDiagnostic) {
            if (
              typeof diagnostic.code !== "string" ||
              typeof diagnostic.message !== "string"
            ) {
              invalidContribution(manifest.id);
            }
            if (warnedPluginIds.has(manifest.id)) return;
            warnedPluginIds.add(manifest.id);
            diagnostics.push(Object.freeze({ ...diagnostic }));
          },
        }),
      });
      if (isThenable(setupResult)) {
        if (setupResult instanceof Promise) {
          void setupResult.catch(() => undefined);
        }
        invalidContribution(manifest.id);
      }
      const contribution = validatePluginContribution(setupResult, manifest);
      routes.push(...contribution.routes);
      middleware.push(...contribution.middleware);
      metadata.push(...contribution.metadata);
      if (contribution.api !== undefined) api.push(contribution.api);
      if (contribution.authentication !== undefined) {
        authentication.push(contribution.authentication);
      }
    } catch (error) {
      if (error instanceof HotUpdaterConstructionError) throw error;
      invalidContribution(manifest.id);
    }
  }

  const router = compileRoutes(routes);
  const selectedAuthentication = selectAuthenticationProvider({
    providers: authentication,
    routes: router.routes.map(matchedRoute),
  });
  return Object.freeze({
    api: projectFeatureApis({
      contributions: api,
      coreApiKeys: options.coreApiKeys ?? [],
    }),
    authentication: selectedAuthentication,
    capabilities,
    diagnostics: Object.freeze(diagnostics),
    metadata: compileVersionMetadata({
      contributions: metadata,
      reservedCoreKeys: options.reservedMetadataKeys,
    }),
    middleware: compilePostAuthMiddleware(middleware),
    router,
  });
};
