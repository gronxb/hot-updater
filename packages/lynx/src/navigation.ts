import {
  close as upstreamClose,
  navigate as upstreamNavigate,
} from "sparkling-navigation";

export { SPARKLING_NAVIGATION_PROVENANCE } from "./navigationProvenance";

declare const lynx: { __globalProps?: { containerID?: unknown } } | undefined;

export interface SparklingNavigationResponse {
  readonly code: number;
  readonly msg: string;
}

export type SparklingNavigationParams = Record<
  string,
  string | number | boolean | undefined
>;

export interface SparklingNavigateOptions {
  readonly params?: SparklingNavigationParams;
  readonly replace?: false;
  readonly useSysBrowser?: false;
  readonly animated?: boolean;
}

export interface SparklingNavigateRequest {
  readonly path: string;
  readonly options?: SparklingNavigateOptions;
  readonly baseScheme?: "hybrid://lynxview_page";
}

export interface SparklingCloseRequest {
  readonly containerID?: string;
  readonly animated?: boolean;
}

type NavigationCallback = (result: SparklingNavigationResponse) => void;

const PAGE_ENTRY_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\/)*[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\.lynx\.bundle$/;
const MANAGED_ROUTER_SCHEME = "hybrid://lynxview_page";
export const SPARKLING_NAVIGATION_LIMITS = {
  decodedKeyUtf8Bytes: 128,
  decodedQueryUtf8Bytes: 2_048,
  decodedValueUtf8Bytes: 1_024,
  customParams: 32,
  rawRouteUtf8Bytes: 4_096,
} as const;
const NAVIGATE_REQUEST_KEYS = new Set(["baseScheme", "options", "path"]);
const NAVIGATE_OPTION_KEYS = new Set([
  "animated",
  "params",
  "replace",
  "useSysBrowser",
]);
const RESERVED_PARAM_KEYS = new Set([
  "animated",
  "baseScheme",
  "bundle",
  "extra",
  "interceptor",
  "replace",
  "replaceType",
  "url",
  "useSysBrowser",
]);

const fail = (callback: NavigationCallback | undefined, msg: string): void => {
  callback?.({ code: -1, msg });
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
};

/** Opens one allowlisted full-page bundle through Sparkling's public router. */
export function navigate(
  request: SparklingNavigateRequest,
  callback: NavigationCallback,
): void {
  if (
    !isObject(request) ||
    Object.keys(request).some((key) => !NAVIGATE_REQUEST_KEYS.has(key)) ||
    typeof request.path !== "string"
  ) {
    fail(callback, "Invalid params: path must be a canonical page entry");
    return;
  }
  const normalized = request.path.trim().replace(/^(?:\.\/|\/)+/, "");
  if (normalized !== request.path || !PAGE_ENTRY_PATTERN.test(request.path)) {
    fail(callback, "Invalid params: path must be a canonical page entry");
    return;
  }
  if (
    request.baseScheme !== undefined &&
    request.baseScheme !== MANAGED_ROUTER_SCHEME
  ) {
    fail(callback, "Invalid params: baseScheme must use the managed router");
    return;
  }

  const options = request.options;
  const routeParams = new URLSearchParams();
  routeParams.set("bundle", request.path);
  if (
    utf8ByteLength(request.path) >
    SPARKLING_NAVIGATION_LIMITS.decodedValueUtf8Bytes
  ) {
    fail(callback, "Invalid params: navigation value is too large");
    return;
  }
  let customParamCount = 0;
  let decodedQueryBytes =
    utf8ByteLength("bundle") + utf8ByteLength(request.path);
  if (options !== undefined) {
    if (
      !isObject(options) ||
      Object.keys(options).some((key) => !NAVIGATE_OPTION_KEYS.has(key)) ||
      (options.replace !== undefined && options.replace !== false) ||
      (options.useSysBrowser !== undefined &&
        options.useSysBrowser !== false) ||
      (options.animated !== undefined && typeof options.animated !== "boolean")
    ) {
      fail(callback, "Invalid params: unsupported managed navigation option");
      return;
    }
    if (options.params !== undefined) {
      if (!isObject(options.params)) {
        fail(callback, "Invalid params: params must be an object");
        return;
      }
      for (const [key, value] of Object.entries(options.params)) {
        if (RESERVED_PARAM_KEYS.has(key)) {
          fail(callback, `Invalid params: reserved navigation key ${key}`);
          return;
        }
        if (
          value !== undefined &&
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        ) {
          fail(callback, `Invalid params: unsupported value for ${key}`);
          return;
        }
        if (value === undefined) continue;
        const serializedValue = String(value);
        if (
          utf8ByteLength(key) > SPARKLING_NAVIGATION_LIMITS.decodedKeyUtf8Bytes
        ) {
          fail(callback, "Invalid params: navigation key is too large");
          return;
        }
        if (
          utf8ByteLength(serializedValue) >
          SPARKLING_NAVIGATION_LIMITS.decodedValueUtf8Bytes
        ) {
          fail(callback, "Invalid params: navigation value is too large");
          return;
        }
        customParamCount += 1;
        decodedQueryBytes +=
          utf8ByteLength(key) + utf8ByteLength(serializedValue);
        routeParams.append(key, serializedValue);
      }
    }
  }

  if (customParamCount > SPARKLING_NAVIGATION_LIMITS.customParams) {
    fail(callback, "Invalid params: too many navigation params");
    return;
  }
  if (decodedQueryBytes > SPARKLING_NAVIGATION_LIMITS.decodedQueryUtf8Bytes) {
    fail(callback, "Invalid params: decoded navigation query is too large");
    return;
  }
  const route = `${request.baseScheme ?? MANAGED_ROUTER_SCHEME}?${routeParams.toString()}`;
  if (utf8ByteLength(route) > SPARKLING_NAVIGATION_LIMITS.rawRouteUtf8Bytes) {
    fail(callback, "Invalid params: navigation route is too large");
    return;
  }

  upstreamNavigate(request, callback);
}

/** Closes the current managed top page through Sparkling's public router. */
export function close(
  request?: SparklingCloseRequest,
  callback?: NavigationCallback,
): void {
  if (request !== undefined) {
    if (
      !isObject(request) ||
      Object.keys(request).some(
        (key) => key !== "animated" && key !== "containerID",
      ) ||
      (request.containerID !== undefined &&
        (typeof request.containerID !== "string" || !request.containerID)) ||
      (request.animated !== undefined && typeof request.animated !== "boolean")
    ) {
      fail(callback, "Invalid params: unsupported managed close option");
      return;
    }
    const sourceContainerID =
      typeof lynx === "undefined"
        ? undefined
        : lynx?.__globalProps?.containerID;
    if (
      request.containerID !== undefined &&
      request.containerID !== sourceContainerID
    ) {
      fail(callback, "Invalid params: containerID must match the source page");
      return;
    }
  }
  upstreamClose(request, callback);
}
