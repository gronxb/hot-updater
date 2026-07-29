import { HotUpdaterConstructionError } from "./errors";
import type {
  ApplyAvailableApi,
  ApplyFeature,
  FeatureApiKind,
  FirstPartyFeatureManifest,
  ManifestAliases,
  ManifestKind,
  ManifestNamespace,
} from "./manifest";

type ResolveAliases<
  TKind extends FeatureApiKind,
  TContext,
  TAliases extends Readonly<Record<string, string>>,
> = Readonly<{
  [TAlias in keyof TAliases]: TAliases[TAlias] extends keyof ApplyAvailableApi<
    TKind,
    TContext
  >
    ? ApplyAvailableApi<TKind, TContext>[TAliases[TAlias]]
    : never;
}>;

type ProjectFeatureState<
  TNamespace extends string,
  TState extends object,
  TResolvedAliases extends object,
> = TState extends { readonly status: "available" }
  ? Readonly<{
      readonly features: Readonly<Record<TNamespace, TState>>;
    }> &
      TResolvedAliases
  : Readonly<{
      readonly features: Readonly<Record<TNamespace, TState>>;
    }>;

type ProjectManifest<TManifest extends FirstPartyFeatureManifest, TContext> = [
  ApplyFeature<ManifestKind<TManifest>, TContext>,
] extends [never]
  ? Readonly<{
      readonly features: Readonly<Record<never, never>>;
    }>
  : ProjectFeatureState<
      ManifestNamespace<TManifest>,
      ApplyFeature<ManifestKind<TManifest>, TContext>,
      ResolveAliases<
        ManifestKind<TManifest>,
        TContext,
        ManifestAliases<TManifest>
      >
    >;

type MergeProjections<TLeft, TRight> = TLeft extends {
  readonly features: infer TLeftFeatures extends object;
}
  ? TRight extends {
      readonly features: infer TRightFeatures extends object;
    }
    ? Readonly<Omit<TLeft, "features"> & Omit<TRight, "features">> & {
        readonly features: Readonly<TLeftFeatures & TRightFeatures>;
      }
    : never
  : never;

export type ProjectPlugins<
  TPlugins extends readonly FirstPartyFeatureManifest[],
  TContext,
> = TPlugins extends readonly [
  infer THead extends FirstPartyFeatureManifest,
  ...infer TTail extends readonly FirstPartyFeatureManifest[],
]
  ? MergeProjections<
      ProjectManifest<THead, TContext>,
      ProjectPlugins<TTail, TContext>
    >
  : Readonly<{
      readonly features: Readonly<Record<never, never>>;
    }>;

export type RuntimeFeatureApiContribution = {
  readonly legacyAliases: Readonly<Record<string, string>>;
  readonly namespace: string;
  readonly value: Readonly<object>;
};

export type ProjectedFeatureApis = {
  readonly aliases: Readonly<Record<string, unknown>>;
  readonly features: Readonly<Record<string, Readonly<object>>>;
};

export const projectFeatureApis = (input: {
  readonly contributions: readonly RuntimeFeatureApiContribution[];
  readonly coreApiKeys: readonly string[];
}): ProjectedFeatureApis => {
  /** Mutable accumulator used only while validating ownership. */
  const features: Record<string, Readonly<object>> = {};
  /** Mutable accumulator used only while validating ownership. */
  const aliases: Record<string, unknown> = {};
  const coreApiKeys = new Set(input.coreApiKeys);

  for (const contribution of [...input.contributions].sort((left, right) =>
    left.namespace.localeCompare(right.namespace),
  )) {
    if (Object.hasOwn(features, contribution.namespace)) {
      throw new HotUpdaterConstructionError("DUPLICATE_API_NAMESPACE", {
        namespace: contribution.namespace,
      });
    }
    const value = Object.freeze({ ...contribution.value });
    Object.defineProperty(features, contribution.namespace, {
      enumerable: true,
      value,
    });
    if (Reflect.get(value, "status") !== "available") continue;

    for (const [alias, member] of Object.entries(
      contribution.legacyAliases,
    ).sort(([left], [right]) => left.localeCompare(right))) {
      if (
        coreApiKeys.has(alias) ||
        Object.hasOwn(aliases, alias) ||
        !Object.hasOwn(value, member)
      ) {
        throw new HotUpdaterConstructionError("DUPLICATE_API_ALIAS", {
          alias,
        });
      }
      Object.defineProperty(aliases, alias, {
        enumerable: true,
        value: Reflect.get(value, member),
      });
    }
  }

  return Object.freeze({
    aliases: Object.freeze(aliases),
    features: Object.freeze(features),
  });
};
