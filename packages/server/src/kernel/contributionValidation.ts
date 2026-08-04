import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterServerRoute,
} from "./contracts";

export type ValidatedPluginContribution = {
  readonly authentication?: HotUpdaterAuthenticationProvider;
  readonly routes: readonly HotUpdaterServerRoute[];
};

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && allowedKeys.has(key),
  );
}

function isAccess(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["kind"]) &&
    (Reflect.get(value, "kind") === "public" ||
      Reflect.get(value, "kind") === "protected")
  );
}

function isRoute(value: unknown): value is HotUpdaterServerRoute {
  if (!isObject(value)) return false;
  const id = Reflect.get(value, "id");
  const input = Reflect.get(value, "input");
  const method = Reflect.get(value, "method");
  const path = Reflect.get(value, "path");
  if (
    !hasOnlyKeys(value, ["access", "handle", "id", "input", "method", "path"])
  ) {
    return false;
  }
  if (!isAccess(Reflect.get(value, "access"))) return false;
  if (typeof Reflect.get(value, "handle") !== "function") return false;
  if (typeof id !== "string" || id.length === 0) return false;
  switch (method) {
    case "DELETE":
    case "GET":
    case "PATCH":
    case "POST":
      break;
    default:
      return false;
  }
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  if (input === undefined) return true;
  return (
    isObject(input) &&
    hasOnlyKeys(input, ["parse"]) &&
    typeof Reflect.get(input, "parse") === "function"
  );
}

function isAuthentication(
  value: unknown,
): value is HotUpdaterAuthenticationProvider {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["authenticate", "id"]) &&
    typeof Reflect.get(value, "authenticate") === "function" &&
    typeof Reflect.get(value, "id") === "string" &&
    Reflect.get(value, "id").length > 0
  );
}

export const validatePluginContribution = (
  value: unknown,
): ValidatedPluginContribution => {
  if (!isObject(value) || !hasOnlyKeys(value, ["authentication", "routes"])) {
    throw new TypeError("Invalid server plugin contribution.");
  }
  const authentication = Reflect.get(value, "authentication");
  const routes = Reflect.get(value, "routes") ?? [];
  if (authentication !== undefined && !isAuthentication(authentication)) {
    throw new TypeError("Invalid server plugin contribution.");
  }
  if (
    !Array.isArray(routes) ||
    !routes.every((route: unknown) => isRoute(route))
  ) {
    throw new TypeError("Invalid server plugin contribution.");
  }
  return Object.freeze({
    ...(authentication === undefined ? {} : { authentication }),
    routes: Object.freeze([...routes]),
  });
};
