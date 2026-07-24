import type { RuntimeFeatureApiContribution } from "./apiProjection";
import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterPostAuthMiddleware,
  HotUpdaterServerRoute,
  HotUpdaterVersionMetadataContribution,
} from "./contracts";
import type { FirstPartyFeatureManifest } from "./manifest";
import { copyPayloadTooLargeResponse } from "./staticResponse";

export type ValidatedPluginContribution = {
  readonly api?: RuntimeFeatureApiContribution;
  readonly authentication?: HotUpdaterAuthenticationProvider;
  readonly metadata: readonly HotUpdaterVersionMetadataContribution[];
  readonly middleware: readonly HotUpdaterPostAuthMiddleware[];
  readonly routes: readonly HotUpdaterServerRoute[];
};

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const isPlainRecord = (value: unknown): value is object =>
  isObject(value) &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const hasOnlyKeys = (value: object, allowed: readonly string[]): boolean => {
  const allowedKeys = new Set(allowed);
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && allowedKeys.has(key),
  );
};

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.every((item: unknown) => typeof item === "string");

const isAccess = (value: unknown): boolean =>
  isObject(value) &&
  hasOnlyKeys(value, ["kind"]) &&
  (Reflect.get(value, "kind") === "public" ||
    Reflect.get(value, "kind") === "protected");

const isRequestPolicy = (value: unknown): boolean => {
  if (!isObject(value)) return false;
  const maximumBodyBytes: unknown = Reflect.get(value, "maximumBodyBytes");
  const configuredResponse: unknown = Reflect.get(
    value,
    "payloadTooLargeResponse",
  );
  return (
    hasOnlyKeys(value, ["maximumBodyBytes", "payloadTooLargeResponse"]) &&
    typeof maximumBodyBytes === "number" &&
    Number.isSafeInteger(maximumBodyBytes) &&
    maximumBodyBytes >= 0 &&
    (configuredResponse === undefined ||
      copyPayloadTooLargeResponse(configuredResponse) !== undefined)
  );
};

const isRoute = (value: unknown): value is HotUpdaterServerRoute => {
  if (!isObject(value)) return false;
  const method: unknown = Reflect.get(value, "method");
  const input: unknown = Reflect.get(value, "input");
  const policy: unknown = Reflect.get(value, "requestPolicy");
  const id: unknown = Reflect.get(value, "id");
  const path: unknown = Reflect.get(value, "path");
  return (
    hasOnlyKeys(value, [
      "access",
      "handle",
      "id",
      "input",
      "method",
      "path",
      "requestPolicy",
    ]) &&
    isAccess(Reflect.get(value, "access")) &&
    typeof Reflect.get(value, "handle") === "function" &&
    typeof id === "string" &&
    id.length > 0 &&
    (method === "DELETE" ||
      method === "GET" ||
      method === "PATCH" ||
      method === "POST") &&
    typeof path === "string" &&
    path.startsWith("/") &&
    (input === undefined ||
      (isObject(input) &&
        hasOnlyKeys(input, ["parse"]) &&
        typeof Reflect.get(input, "parse") === "function")) &&
    (policy === undefined || isRequestPolicy(policy))
  );
};

const isMiddleware = (
  value: unknown,
): value is HotUpdaterPostAuthMiddleware => {
  if (!isObject(value)) return false;
  const after = Reflect.get(value, "after");
  const before = Reflect.get(value, "before");
  return (
    hasOnlyKeys(value, ["after", "before", "handle", "id", "phase"]) &&
    (after === undefined || isStringArray(after)) &&
    (before === undefined || isStringArray(before)) &&
    typeof Reflect.get(value, "handle") === "function" &&
    typeof Reflect.get(value, "id") === "string" &&
    Reflect.get(value, "id").length > 0 &&
    Reflect.get(value, "phase") === "post-auth"
  );
};

const isMetadata = (
  value: unknown,
): value is HotUpdaterVersionMetadataContribution =>
  isObject(value) &&
  hasOnlyKeys(value, [
    "keys",
    "namespace",
    "optionalKeys",
    "resolve",
    "target",
  ]) &&
  isStringArray(Reflect.get(value, "keys")) &&
  (Reflect.get(value, "optionalKeys") === undefined ||
    isStringArray(Reflect.get(value, "optionalKeys"))) &&
  typeof Reflect.get(value, "namespace") === "string" &&
  Reflect.get(value, "namespace").length > 0 &&
  typeof Reflect.get(value, "resolve") === "function" &&
  Reflect.get(value, "target") === "capabilities";

const isAuthentication = (
  value: unknown,
): value is HotUpdaterAuthenticationProvider =>
  isObject(value) &&
  hasOnlyKeys(value, ["authenticate", "id"]) &&
  typeof Reflect.get(value, "authenticate") === "function" &&
  typeof Reflect.get(value, "id") === "string" &&
  Reflect.get(value, "id").length > 0;

const isAliases = (
  value: unknown,
  expected: Readonly<Record<string, string>>,
): value is Readonly<Record<string, string>> => {
  if (!isPlainRecord(value)) return false;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return (
    entries.length === expectedEntries.length &&
    entries.every(
      ([key, member], index) =>
        typeof member === "string" &&
        key === expectedEntries[index]?.[0] &&
        member === expectedEntries[index]?.[1],
    )
  );
};

const readApi = (
  value: unknown,
  manifest: FirstPartyFeatureManifest,
): RuntimeFeatureApiContribution | undefined => {
  if (value === undefined) return undefined;
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["legacyAliases", "namespace", "value"])
  ) {
    throw new Error("Invalid API contribution.");
  }
  const aliases = Reflect.get(value, "legacyAliases");
  const apiValue = Reflect.get(value, "value");
  if (
    Reflect.get(value, "namespace") !== manifest.namespace ||
    !isAliases(aliases, manifest.aliases) ||
    !isPlainRecord(apiValue)
  ) {
    throw new Error("Invalid API contribution.");
  }
  return Object.freeze({
    legacyAliases: Object.freeze({ ...aliases }),
    namespace: manifest.namespace,
    value: apiValue,
  });
};

export const validatePluginContribution = (
  value: unknown,
  manifest: FirstPartyFeatureManifest,
): ValidatedPluginContribution => {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "api",
      "authentication",
      "metadata",
      "middleware",
      "routes",
    ])
  ) {
    throw new Error("Invalid plugin contribution.");
  }
  const authentication = Reflect.get(value, "authentication");
  const metadata = Reflect.get(value, "metadata") ?? [];
  const middleware = Reflect.get(value, "middleware") ?? [];
  const routes = Reflect.get(value, "routes") ?? [];
  if (
    (authentication !== undefined && !isAuthentication(authentication)) ||
    !Array.isArray(metadata) ||
    !metadata.every((item: unknown) => isMetadata(item)) ||
    !Array.isArray(middleware) ||
    !middleware.every((item: unknown) => isMiddleware(item)) ||
    !Array.isArray(routes) ||
    !routes.every((item: unknown) => isRoute(item))
  ) {
    throw new Error("Invalid plugin contribution.");
  }
  return Object.freeze({
    api: readApi(Reflect.get(value, "api"), manifest),
    authentication,
    metadata: Object.freeze([...metadata]),
    middleware: Object.freeze([...middleware]),
    routes: Object.freeze([...routes]),
  });
};
