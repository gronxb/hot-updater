import type {
  CapabilityToken,
  ConfigFeatureManifest,
  DatabaseCapabilityRuntime,
  FeatureInvocationMap,
  InvocationAwareFeatureValue,
} from "@hot-updater/plugin-core";
import {
  isConfigFeatureManifest,
  stampConfigFeatureManifest,
} from "@hot-updater/plugin-core/internal/config-feature-manifest";

import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterPostAuthMiddleware,
  HotUpdaterRoutePolicy,
  HotUpdaterServerRoute,
  HotUpdaterVersionMetadataContribution,
} from "./contracts";

const featureManifestBrand: unique symbol = Symbol(
  "@hot-updater/server/first-party-feature-manifest",
);

export interface FeatureApiKind {
  readonly availableApi: object;
  readonly context: unknown;
  readonly feature: object;
}

export interface NoFeatureApiKind extends FeatureApiKind {
  readonly availableApi: never;
  readonly feature: never;
}

export type ApplyFeature<TKind extends FeatureApiKind, TContext> = (TKind & {
  readonly context: TContext;
})["feature"];

export type ApplyAvailableApi<
  TKind extends FeatureApiKind,
  TContext,
> = (TKind & { readonly context: TContext })["availableApi"];

export type FeatureApiAliases<TKind extends FeatureApiKind> = Readonly<
  Record<string, Extract<keyof ApplyAvailableApi<TKind, unknown>, string>>
>;

export type HotUpdaterCapabilityRequirement = {
  readonly missing: "continue" | "error";
  readonly token: CapabilityToken<unknown>;
};

export type HotUpdaterConstructionDiagnostic = {
  readonly code: string;
  readonly message: string;
};

export type HotUpdaterPluginSetupContext = {
  readonly capabilities: {
    get<TValue>(token: CapabilityToken<TValue>): TValue | undefined;
    require<TValue>(token: CapabilityToken<TValue>): TValue;
  };
  readonly database: DatabaseCapabilityRuntime;
  readonly diagnostics: {
    warn(diagnostic: HotUpdaterConstructionDiagnostic): void;
  };
};

export type HotUpdaterFeatureApiContribution<
  TNamespace extends string,
  TKind extends FeatureApiKind,
  TAliases extends Readonly<Record<string, string>>,
> = {
  readonly invocation: FeatureInvocationMap;
  readonly legacyAliases: TAliases;
  readonly namespace: TNamespace;
  readonly value: InvocationAwareFeatureValue<
    ApplyAvailableApi<TKind, unknown>,
    unknown
  > &
    ApplyFeature<TKind, unknown>;
};

export type FeatureApiMode<TKind extends FeatureApiKind> = [
  ApplyFeature<TKind, unknown>,
] extends [never]
  ? "none"
  : "required";

type FeatureApiContribution<
  TNamespace extends string,
  TKind extends FeatureApiKind,
  TAliases extends Readonly<Record<string, string>>,
> =
  FeatureApiMode<TKind> extends "required"
    ? {
        readonly api: HotUpdaterFeatureApiContribution<
          TNamespace,
          TKind,
          TAliases
        >;
      }
    : { readonly api?: never };

type FeatureApiDefinition<TKind extends FeatureApiKind> =
  FeatureApiMode<TKind> extends "required"
    ? { readonly featureApi: "required" }
    : { readonly featureApi?: "none" };

export type HotUpdaterPluginContribution<
  TNamespace extends string,
  TKind extends FeatureApiKind,
  TAliases extends Readonly<Record<string, string>>,
> = FeatureApiContribution<TNamespace, TKind, TAliases> & {
  readonly authentication?: HotUpdaterAuthenticationProvider;
  readonly metadata?: readonly HotUpdaterVersionMetadataContribution[];
  readonly middleware?: readonly HotUpdaterPostAuthMiddleware[];
  readonly routePolicy?: HotUpdaterRoutePolicy;
  readonly routes?: readonly HotUpdaterServerRoute[];
};

export interface HotUpdaterFeatureManifest<
  TNamespace extends string = string,
  TKind extends FeatureApiKind = FeatureApiKind,
  TAliases extends FeatureApiAliases<TKind> = Readonly<Record<never, never>>,
> extends ConfigFeatureManifest {
  readonly [featureManifestBrand]: {
    readonly aliases: TAliases;
    readonly kind: (kind: TKind) => TKind;
    readonly namespace: TNamespace;
  };
  readonly aliases: TAliases;
  readonly featureApi: "none" | "required";
  readonly id: string;
  readonly namespace: TNamespace;
  readonly requires: readonly HotUpdaterCapabilityRequirement[];
  readonly setup: (
    context: HotUpdaterPluginSetupContext,
  ) => HotUpdaterPluginContribution<TNamespace, TKind, TAliases>;
  readonly version: string;
}

type BrandedManifest = {
  readonly [featureManifestBrand]: object;
};

export type FirstPartyFeatureManifest = ConfigFeatureManifest &
  BrandedManifest & {
    readonly aliases: Readonly<Record<string, string>>;
    readonly featureApi: "none" | "required";
    readonly id: string;
    readonly namespace: string;
    readonly requires: readonly HotUpdaterCapabilityRequirement[];
    readonly setup: (context: HotUpdaterPluginSetupContext) => unknown;
    readonly version: string;
  };

export type ManifestNamespace<TManifest extends BrandedManifest> =
  TManifest[typeof featureManifestBrand] extends {
    readonly namespace: infer TNamespace extends string;
  }
    ? TNamespace
    : never;

export type ManifestKind<TManifest extends BrandedManifest> =
  TManifest[typeof featureManifestBrand] extends {
    readonly kind: (kind: infer TKind extends FeatureApiKind) => FeatureApiKind;
  }
    ? TKind
    : never;

export type ManifestAliases<TManifest extends BrandedManifest> =
  TManifest[typeof featureManifestBrand] extends {
    readonly aliases: infer TAliases extends Readonly<Record<string, string>>;
  }
    ? TAliases
    : never;

export type FirstPartyFeatureManifestDefinition<
  TNamespace extends string,
  TKind extends FeatureApiKind,
  TAliases extends FeatureApiAliases<TKind>,
> = FeatureApiDefinition<TKind> & {
  readonly aliases: TAliases;
  readonly id: string;
  readonly namespace: TNamespace;
  readonly requires?: readonly HotUpdaterCapabilityRequirement[];
  readonly setup: (
    context: HotUpdaterPluginSetupContext,
  ) => HotUpdaterPluginContribution<TNamespace, TKind, TAliases>;
  readonly version: string;
};

export const defineFirstPartyFeatureManifest = <
  TNamespace extends string,
  TKind extends FeatureApiKind,
  const TAliases extends FeatureApiAliases<TKind>,
>(
  definition: FirstPartyFeatureManifestDefinition<TNamespace, TKind, TAliases>,
): HotUpdaterFeatureManifest<TNamespace, TKind, TAliases> => {
  const aliases = Object.freeze({ ...definition.aliases });
  const requires = Object.freeze(
    (definition.requires ?? []).map((requirement) =>
      Object.freeze({
        missing: requirement.missing,
        token: requirement.token,
      }),
    ),
  );

  return stampConfigFeatureManifest({
    [featureManifestBrand]: Object.freeze({
      aliases,
      kind: (kind: TKind) => kind,
      namespace: definition.namespace,
    }),
    aliases,
    featureApi: definition.featureApi ?? "none",
    id: definition.id,
    namespace: definition.namespace,
    requires,
    setup: definition.setup,
    version: definition.version,
  });
};

export const isFirstPartyFeatureManifest = (
  value: unknown,
): value is FirstPartyFeatureManifest =>
  isConfigFeatureManifest(value) &&
  typeof Reflect.get(value, "aliases") === "object" &&
  Reflect.get(value, "aliases") !== null &&
  (Reflect.get(value, "featureApi") === "none" ||
    Reflect.get(value, "featureApi") === "required") &&
  Array.isArray(Reflect.get(value, "requires")) &&
  typeof Reflect.get(value, "setup") === "function";
