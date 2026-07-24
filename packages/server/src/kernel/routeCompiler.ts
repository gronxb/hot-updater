import type {
  HotUpdaterHttpMethod,
  HotUpdaterMatchedRoute,
  HotUpdaterRequestPolicy,
  HotUpdaterServerRoute,
} from "./contracts";
import { HotUpdaterConstructionError } from "./errors";
import { copyPayloadTooLargeResponse } from "./staticResponse";

type CompiledRouteSegment =
  | { readonly kind: "parameter"; readonly name: string }
  | { readonly kind: "static"; readonly value: string };

export type CompiledRoute = HotUpdaterServerRoute & {
  readonly canonicalPath: string;
  readonly path: `/${string}`;
  readonly segments: readonly CompiledRouteSegment[];
};

export type CompiledRouter = {
  readonly routes: readonly CompiledRoute[];
};

export type CompiledRouteMatch = {
  readonly descriptor: HotUpdaterMatchedRoute;
  readonly route: CompiledRoute;
};

const invalidRoute = (routeId: string): never => {
  throw new HotUpdaterConstructionError("INVALID_PLUGIN_CONTRIBUTION", {
    pluginId: routeId,
  });
};

const tryNormalizePlainPath = (path: string): string | undefined => {
  if (path.includes("?") || path.includes("#")) return undefined;
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/u, "");
  const segments = withoutTrailingSlash.split("/").slice(1);
  if (segments.some((segment) => segment.length === 0)) {
    return undefined;
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
};

const normalizePlainPath = (routeId: string, path: string): string =>
  tryNormalizePlainPath(path) ?? invalidRoute(routeId);

const normalizePattern = (
  routeId: string,
  path: `/${string}`,
): `/${string}` => {
  const normalized = normalizePlainPath(routeId, path);
  return normalized === "/" ? "/" : `/${normalized.slice(1)}`;
};

const copyRequestPolicy = (
  routeId: string,
  policy: HotUpdaterRequestPolicy | undefined,
): HotUpdaterRequestPolicy | undefined => {
  if (policy === undefined) return undefined;
  if (
    policy.maximumBodyBytes === undefined ||
    !Number.isSafeInteger(policy.maximumBodyBytes) ||
    policy.maximumBodyBytes < 0
  ) {
    return invalidRoute(routeId);
  }
  const configuredResponse =
    policy.payloadTooLargeResponse === undefined
      ? undefined
      : copyPayloadTooLargeResponse(policy.payloadTooLargeResponse);
  if (
    policy.payloadTooLargeResponse !== undefined &&
    configuredResponse === undefined
  ) {
    return invalidRoute(routeId);
  }
  return Object.freeze({
    maximumBodyBytes: policy.maximumBodyBytes,
    ...(configuredResponse === undefined
      ? {}
      : { payloadTooLargeResponse: configuredResponse }),
  });
};

const compileSegments = (
  routeId: string,
  path: `/${string}`,
): readonly CompiledRouteSegment[] => {
  if (path === "/") return Object.freeze([]);
  const names = new Set<string>();
  const segments = path
    .slice(1)
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) {
        return Object.freeze({
          kind: "static",
          value: segment,
        }) satisfies CompiledRouteSegment;
      }

      const name = segment.slice(1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || names.has(name)) {
        return invalidRoute(routeId);
      }
      names.add(name);
      return Object.freeze({
        kind: "parameter",
        name,
      }) satisfies CompiledRouteSegment;
    });
  return Object.freeze(segments);
};

const compareRoutes = (left: CompiledRoute, right: CompiledRoute): number => {
  if (left.method !== right.method) {
    return left.method.localeCompare(right.method);
  }
  for (let index = 0; index < left.segments.length; index += 1) {
    const leftSegment = left.segments[index];
    const rightSegment = right.segments[index];
    if (rightSegment === undefined) return 1;
    if (leftSegment.kind !== rightSegment.kind) {
      return leftSegment.kind === "static" ? -1 : 1;
    }
    if (
      leftSegment.kind === "static" &&
      rightSegment.kind === "static" &&
      leftSegment.value !== rightSegment.value
    ) {
      return leftSegment.value.localeCompare(rightSegment.value);
    }
  }
  if (left.segments.length !== right.segments.length) {
    return left.segments.length - right.segments.length;
  }
  return left.id.localeCompare(right.id);
};

export const compileRoutes = (
  routes: readonly HotUpdaterServerRoute[],
): CompiledRouter => {
  const routeIds = new Set<string>();
  const canonicalRoutes = new Set<string>();
  const compiled = routes.map((route) => {
    if (routeIds.has(route.id)) {
      throw new HotUpdaterConstructionError("DUPLICATE_ROUTE_ID", {
        routeId: route.id,
      });
    }
    routeIds.add(route.id);
    const path = normalizePattern(route.id, route.path);
    const segments = compileSegments(route.id, path);
    const canonicalPath =
      segments.length === 0
        ? "/"
        : `/${segments
            .map((segment) => (segment.kind === "static" ? segment.value : ":"))
            .join("/")}`;
    const canonicalKey = `${route.method} ${canonicalPath}`;
    if (canonicalRoutes.has(canonicalKey)) {
      throw new HotUpdaterConstructionError("DUPLICATE_ROUTE", {
        method: route.method,
        path,
      });
    }
    canonicalRoutes.add(canonicalKey);
    return Object.freeze({
      ...route,
      access: Object.freeze({ ...route.access }),
      canonicalPath,
      input:
        route.input === undefined
          ? undefined
          : Object.freeze({ parse: route.input.parse }),
      path,
      requestPolicy:
        route.requestPolicy === undefined
          ? undefined
          : copyRequestPolicy(route.id, route.requestPolicy),
      segments,
    });
  });
  return Object.freeze({ routes: Object.freeze(compiled.sort(compareRoutes)) });
};

const relativePath = (
  pathname: string,
  basePath: string,
): string | undefined => {
  const normalizedBase = normalizePlainPath("core.base-path", basePath);
  if (normalizedBase === "/") return pathname;
  if (pathname === normalizedBase) return "/";
  return pathname.startsWith(`${normalizedBase}/`)
    ? pathname.slice(normalizedBase.length)
    : undefined;
};

const matchRoute = (
  route: CompiledRoute,
  pathSegments: readonly string[],
): Readonly<Record<string, string>> | undefined => {
  if (route.segments.length !== pathSegments.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const routeSegment = route.segments[index];
    const pathSegment = pathSegments[index];
    if (pathSegment === undefined) return undefined;
    if (routeSegment.kind === "static") {
      if (routeSegment.value !== pathSegment) return undefined;
    } else {
      params[routeSegment.name] = pathSegment;
    }
  }
  return Object.freeze(params);
};

export const matchCompiledRoute = (input: {
  readonly basePath: string;
  readonly method: string;
  readonly pathname: string;
  readonly router: CompiledRouter;
}): CompiledRouteMatch | undefined => {
  const path = relativePath(input.pathname, input.basePath);
  if (path === undefined) return undefined;
  const normalizedPath = tryNormalizePlainPath(path);
  if (normalizedPath === undefined) return undefined;
  const pathSegments =
    normalizedPath === "/" ? [] : normalizedPath.slice(1).split("/");
  const normalizedMethod = input.method.toUpperCase();
  for (const route of input.router.routes) {
    if (route.method !== normalizedMethod) continue;
    const params = matchRoute(route, pathSegments);
    if (params === undefined) continue;
    const descriptor = Object.freeze({
      access: route.access,
      id: route.id,
      method: route.method,
      params,
      pattern: route.path,
    }) satisfies HotUpdaterMatchedRoute;
    return Object.freeze({ descriptor, route });
  }
  return undefined;
};

export const isBodyCapableMethod = (method: HotUpdaterHttpMethod): boolean =>
  method === "DELETE" || method === "PATCH" || method === "POST";
