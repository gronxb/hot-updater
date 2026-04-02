interface RouteRecord<T> {
  data: T;
  method: string;
  paramNames: string[];
  segments: string[];
}

interface RouteMatch<T> {
  data: T;
  params: Record<string, string>;
}

interface Router<T> {
  routes: RouteRecord<T>[];
}

const normalizePath = (path: string) => {
  if (!path) {
    return "/";
  }

  if (path === "/") {
    return path;
  }

  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
};

const toSegments = (path: string) => {
  const normalized = normalizePath(path);
  return normalized === "/" ? [] : normalized.slice(1).split("/");
};

export function createRouter<T>(): Router<T> {
  return { routes: [] };
}

export function addRoute<T>(
  router: Router<T>,
  method: string,
  path: string,
  data: T,
) {
  const segments = toSegments(path);
  const paramNames = segments
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));

  router.routes.push({
    data,
    method: method.toUpperCase(),
    paramNames,
    segments,
  });
}

export function findRoute<T>(
  router: Router<T>,
  method: string,
  path: string,
): RouteMatch<T> | undefined {
  const normalizedMethod = method.toUpperCase();
  const pathSegments = toSegments(path);

  for (const route of router.routes) {
    if (route.method !== normalizedMethod) {
      continue;
    }

    if (route.segments.length !== pathSegments.length) {
      continue;
    }

    const params: Record<string, string> = {};
    let matched = true;

    for (let index = 0; index < route.segments.length; index += 1) {
      const routeSegment = route.segments[index];
      const pathSegment = pathSegments[index];

      if (routeSegment.startsWith(":")) {
        params[routeSegment.slice(1)] = pathSegment;
        continue;
      }

      if (routeSegment !== pathSegment) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return {
        data: route.data,
        params,
      };
    }
  }

  return undefined;
}
