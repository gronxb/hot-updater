import type {
  HotUpdaterMatchedRoute,
  HotUpdaterServerRoute,
} from "./contracts";
import { HotUpdaterConstructionError } from "./errors";

type CompiledRouteSegment =
  | { readonly kind: "parameter"; readonly name: string }
  | { readonly kind: "static"; readonly value: string };

export type CompiledRoute = HotUpdaterServerRoute & {
  readonly canonicalPath: string;
  readonly segments: readonly CompiledRouteSegment[];
};

export type CompiledRouter = {
  readonly routes: readonly CompiledRoute[];
};

export type CompiledRouteMatch = {
  readonly descriptor: HotUpdaterMatchedRoute;
  readonly route: CompiledRoute;
};

function invalidRoute(routeId: string): never {
  throw new HotUpdaterConstructionError("INVALID_PLUGIN_CONTRIBUTION", {
    pluginId: routeId,
  });
}

function tryNormalizePath(path: string): `/${string}` | undefined {
  if (path.includes("?") || path.includes("#")) return undefined;
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/u, "");
  const segments = withoutTrailingSlash.split("/").slice(1);
  if (segments.some((segment) => segment.length === 0)) return undefined;
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function normalizePath(routeId: string, path: string): `/${string}` {
  const normalizedPath = tryNormalizePath(path);
  if (normalizedPath === undefined) return invalidRoute(routeId);
  return normalizedPath;
}

function compileSegments(
  routeId: string,
  path: `/${string}`,
): readonly CompiledRouteSegment[] {
  if (path === "/") return Object.freeze([]);

  const parameterNames = new Set<string>();
  const compiledSegments: CompiledRouteSegment[] = [];

  for (const segment of path.slice(1).split("/")) {
    if (!segment.startsWith(":")) {
      compiledSegments.push(
        Object.freeze({
          kind: "static",
          value: segment,
        }),
      );
      continue;
    }

    const name = segment.slice(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || parameterNames.has(name)) {
      return invalidRoute(routeId);
    }
    parameterNames.add(name);
    compiledSegments.push(Object.freeze({ kind: "parameter", name }));
  }

  return Object.freeze(compiledSegments);
}

function compareRoutes(left: CompiledRoute, right: CompiledRoute): number {
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
}

export function compileRoutes(
  routes: readonly HotUpdaterServerRoute[],
): CompiledRouter {
  const routeIds = new Set<string>();
  const canonicalRoutes = new Set<string>();
  const compiled = routes.map((route) => {
    if (routeIds.has(route.id)) {
      throw new HotUpdaterConstructionError("DUPLICATE_ROUTE_ID", {
        routeId: route.id,
      });
    }
    routeIds.add(route.id);
    const path = normalizePath(route.id, route.path);
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
    const parser = route.input;
    return Object.freeze({
      ...route,
      access: Object.freeze({ ...route.access }),
      canonicalPath,
      input:
        parser === undefined
          ? undefined
          : Object.freeze({
              async parse(request: Request): Promise<unknown> {
                return parser.parse(request);
              },
            }),
      path,
      segments,
    });
  });
  return Object.freeze({ routes: Object.freeze(compiled.sort(compareRoutes)) });
}

function getCandidatePaths(
  pathname: string,
  basePath: string,
): readonly string[] {
  const normalizedBase = normalizePath("core.base-path", basePath);
  if (normalizedBase === "/") return [pathname];
  if (pathname === normalizedBase) return ["/"];
  if (pathname.startsWith(`${normalizedBase}/`)) {
    return [pathname.slice(normalizedBase.length), pathname];
  }
  return [pathname];
}

function matchRoute(
  route: CompiledRoute,
  pathSegments: readonly string[],
): Readonly<Record<string, string>> | undefined {
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
}

export function matchCompiledRoute(input: {
  readonly basePath: string;
  readonly method: string;
  readonly pathname: string;
  readonly router: CompiledRouter;
}): CompiledRouteMatch | undefined {
  const normalizedMethod = input.method.toUpperCase();
  for (const path of getCandidatePaths(input.pathname, input.basePath)) {
    const normalizedPath = tryNormalizePath(path);
    if (normalizedPath === undefined) continue;
    const pathSegments =
      normalizedPath === "/" ? [] : normalizedPath.slice(1).split("/");
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
  }
  return undefined;
}
