type StandaloneTransportErrorCode = "invalid-base-url" | "invalid-destination";

export interface StandaloneTransportConfig {
  readonly baseUrl: string;
  readonly commonHeaders?: Readonly<Record<string, string>>;
}

export interface StandaloneTransportRoute {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface StandaloneRequestOptions {
  readonly body?: RequestInit["body"];
  readonly headerPolicy?: {
    readonly omit?: readonly string[];
    readonly set?: Readonly<Record<string, string>>;
  };
  readonly method: string;
  readonly searchParams?: URLSearchParams;
  readonly signal?: AbortSignal;
}

export class StandaloneTransportError extends Error {
  readonly name = "StandaloneTransportError";

  constructor(readonly code: StandaloneTransportErrorCode) {
    super("Standalone transport configuration is invalid.");
  }
}

export const parseStandaloneBaseUrl = (baseUrl: string): URL => {
  if (!URL.canParse(baseUrl)) {
    throw new StandaloneTransportError("invalid-base-url");
  }
  const parsed = new URL(baseUrl);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new StandaloneTransportError("invalid-base-url");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/`;
  return parsed;
};

const absoluteDestination = /^[a-z][a-z\d+.-]*:/i;
const encodedUnsafePathValue = /%(?:23|25|2e|2f|40|5c)/i;

export const resolveStandaloneDestination = (
  baseUrl: URL,
  routePath: string,
): URL => {
  const path = routePath.split("?", 1)[0] ?? "";
  const segments = path.split("/");
  const invalid =
    routePath !== routePath.trim() ||
    absoluteDestination.test(routePath) ||
    routePath.startsWith("//") ||
    routePath.includes("\\") ||
    routePath.includes("#") ||
    routePath.includes("@") ||
    encodedUnsafePathValue.test(routePath) ||
    segments.some((segment) => segment === "." || segment === "..");
  if (invalid) {
    throw new StandaloneTransportError("invalid-destination");
  }
  const relativePath = routePath.startsWith("/")
    ? routePath.slice(1)
    : routePath;
  const destination = new URL(relativePath, baseUrl);
  if (
    destination.origin !== baseUrl.origin ||
    !destination.pathname.startsWith(baseUrl.pathname)
  ) {
    throw new StandaloneTransportError("invalid-destination");
  }
  return destination;
};

export const createStandaloneTransport = (
  config: StandaloneTransportConfig,
) => {
  const baseUrl = parseStandaloneBaseUrl(config.baseUrl);
  const resolve = (path: string): URL =>
    resolveStandaloneDestination(baseUrl, path);
  const request = (
    route: StandaloneTransportRoute,
    options: StandaloneRequestOptions,
  ): Promise<Response> => {
    const destination = resolve(route.path);
    const searchKeys = new Set(options.searchParams?.keys());
    for (const key of searchKeys) {
      destination.searchParams.delete(key);
      for (const value of options.searchParams?.getAll(key) ?? []) {
        destination.searchParams.append(key, value);
      }
    }
    const headers = new Headers(config.commonHeaders);
    for (const [key, value] of Object.entries(route.headers ?? {})) {
      headers.set(key, value);
    }
    for (const key of options.headerPolicy?.omit ?? []) {
      headers.delete(key);
    }
    for (const [key, value] of Object.entries(
      options.headerPolicy?.set ?? {},
    )) {
      headers.set(key, value);
    }
    return fetch(destination, {
      ...(options.body === undefined ? {} : { body: options.body }),
      headers,
      method: options.method,
      redirect: "error",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  };
  return Object.freeze({ request, resolve });
};
