export const CONSTRUCTION_ERROR_CODES = [
  "DUPLICATE_PLUGIN_ID",
  "DUPLICATE_CAPABILITY_TOKEN_ID",
  "DUPLICATE_CAPABILITY_PROVIDER",
  "MISSING_CAPABILITY",
  "INVALID_CAPABILITY",
  "DUPLICATE_ROUTE_ID",
  "DUPLICATE_ROUTE",
  "DUPLICATE_METADATA_NAMESPACE",
  "DUPLICATE_METADATA_WIRE_KEY",
  "DUPLICATE_API_NAMESPACE",
  "DUPLICATE_API_ALIAS",
  "DUPLICATE_MIDDLEWARE_ID",
  "UNKNOWN_MIDDLEWARE_DEPENDENCY",
  "MIDDLEWARE_DEPENDENCY_CYCLE",
  "MULTIPLE_AUTHENTICATION_PROVIDERS",
  "PROTECTED_ROUTE_WITHOUT_AUTHENTICATION",
  "INVALID_PLUGIN_CONTRIBUTION",
] as const;

export type HotUpdaterConstructionErrorCode =
  (typeof CONSTRUCTION_ERROR_CODES)[number];

export type HotUpdaterConstructionErrorDetails = {
  readonly DUPLICATE_PLUGIN_ID: { readonly pluginId: string };
  readonly DUPLICATE_CAPABILITY_TOKEN_ID: { readonly tokenId: string };
  readonly DUPLICATE_CAPABILITY_PROVIDER: { readonly tokenId: string };
  readonly MISSING_CAPABILITY: {
    readonly pluginId: string;
    readonly tokenId: string;
  };
  readonly INVALID_CAPABILITY: { readonly tokenId: string };
  readonly DUPLICATE_ROUTE_ID: { readonly routeId: string };
  readonly DUPLICATE_ROUTE: {
    readonly method: string;
    readonly path: string;
  };
  readonly DUPLICATE_METADATA_NAMESPACE: { readonly namespace: string };
  readonly DUPLICATE_METADATA_WIRE_KEY: { readonly key: string };
  readonly DUPLICATE_API_NAMESPACE: { readonly namespace: string };
  readonly DUPLICATE_API_ALIAS: { readonly alias: string };
  readonly DUPLICATE_MIDDLEWARE_ID: { readonly middlewareId: string };
  readonly UNKNOWN_MIDDLEWARE_DEPENDENCY: {
    readonly dependencyId: string;
    readonly middlewareId: string;
  };
  readonly MIDDLEWARE_DEPENDENCY_CYCLE: {
    readonly middlewareIds: readonly string[];
  };
  readonly MULTIPLE_AUTHENTICATION_PROVIDERS: {
    readonly providerIds: readonly string[];
  };
  readonly PROTECTED_ROUTE_WITHOUT_AUTHENTICATION: {
    readonly routeId: string;
  };
  readonly INVALID_PLUGIN_CONTRIBUTION: { readonly pluginId: string };
};

export class HotUpdaterConstructionError<
  TCode extends HotUpdaterConstructionErrorCode,
> extends Error {
  readonly name = "HotUpdaterConstructionError";
  readonly details: Readonly<HotUpdaterConstructionErrorDetails[TCode]>;

  constructor(
    readonly code: TCode,
    details: HotUpdaterConstructionErrorDetails[TCode],
  ) {
    super(`Hot Updater construction failed (${code}).`);
    this.details = Object.freeze(details);
  }
}
