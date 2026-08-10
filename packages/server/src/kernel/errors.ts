export const CONSTRUCTION_ERROR_CODES = [
  "DUPLICATE_PLUGIN_ID",
  "DUPLICATE_COMPONENT_ID",
  "DUPLICATE_COMPONENT_INDEX",
  "DUPLICATE_COMPONENT_TABLE",
  "DUPLICATE_CAPABILITY_TOKEN_ID",
  "DUPLICATE_CAPABILITY_PROVIDER",
  "MISSING_CAPABILITY",
  "INVALID_CAPABILITY",
  "DUPLICATE_ROUTE_ID",
  "DUPLICATE_ROUTE",
  "MULTIPLE_AUTHENTICATION_PROVIDERS",
  "PROTECTED_ROUTE_WITHOUT_AUTHENTICATION",
  "INVALID_PLUGIN_CONTRIBUTION",
  "INVALID_COMPONENT_SCHEMA",
  "INVALID_COMPONENT_DATA_ADAPTER",
  "MISSING_COMPONENT_DATA_ADAPTER",
] as const;

export type HotUpdaterConstructionErrorCode =
  (typeof CONSTRUCTION_ERROR_CODES)[number];

export type HotUpdaterConstructionErrorDetails = {
  readonly DUPLICATE_PLUGIN_ID: { readonly pluginId: string };
  readonly DUPLICATE_COMPONENT_ID: { readonly componentId: string };
  readonly DUPLICATE_COMPONENT_INDEX: { readonly indexName: string };
  readonly DUPLICATE_COMPONENT_TABLE: { readonly tableName: string };
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
  readonly MULTIPLE_AUTHENTICATION_PROVIDERS: {
    readonly providerIds: readonly string[];
  };
  readonly PROTECTED_ROUTE_WITHOUT_AUTHENTICATION: {
    readonly routeId: string;
  };
  readonly INVALID_PLUGIN_CONTRIBUTION: { readonly pluginId: string };
  readonly INVALID_COMPONENT_SCHEMA: { readonly pluginId: string };
  readonly INVALID_COMPONENT_DATA_ADAPTER: { readonly componentId: string };
  readonly MISSING_COMPONENT_DATA_ADAPTER: {
    readonly componentIds: readonly string[];
  };
};

export class HotUpdaterConstructionError<
  TCode extends HotUpdaterConstructionErrorCode =
    HotUpdaterConstructionErrorCode,
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

export function isHotUpdaterConstructionError(
  value: unknown,
): value is HotUpdaterConstructionError;
export function isHotUpdaterConstructionError<
  TCode extends HotUpdaterConstructionErrorCode,
>(value: unknown, code: TCode): value is HotUpdaterConstructionError<TCode>;
export function isHotUpdaterConstructionError(
  value: unknown,
  code?: HotUpdaterConstructionErrorCode,
): value is HotUpdaterConstructionError {
  return (
    value instanceof HotUpdaterConstructionError &&
    (code === undefined || value.code === code)
  );
}
