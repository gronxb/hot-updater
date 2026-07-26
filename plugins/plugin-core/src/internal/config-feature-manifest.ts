const configFeatureManifestBrand: unique symbol = Symbol.for(
  "@hot-updater/plugin-core/config-feature-manifest/v1",
);

type ConfigFeatureManifestShape = Readonly<{
  id: string;
  namespace: string;
  version: string;
}>;

export type ConfigFeatureManifest = ConfigFeatureManifestShape &
  Readonly<{
    [configFeatureManifestBrand]: true;
  }>;

export const stampConfigFeatureManifest = <
  const TManifest extends ConfigFeatureManifestShape,
>(
  manifest: TManifest,
): Readonly<TManifest> & ConfigFeatureManifest =>
  Object.freeze({
    ...manifest,
    [configFeatureManifestBrand]: true as const,
  });

export const isConfigFeatureManifest = (
  value: unknown,
): value is ConfigFeatureManifest =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, configFeatureManifestBrand) === true &&
  typeof Reflect.get(value, "id") === "string" &&
  typeof Reflect.get(value, "namespace") === "string" &&
  typeof Reflect.get(value, "version") === "string";
