import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterAuthenticationResult,
  HotUpdaterMatchedRoute,
  HotUpdaterPrincipal,
  HotUpdaterRequestExecutionContext,
} from "./contracts";
import { HotUpdaterConstructionError } from "./errors";

const textEncoder = new TextEncoder();

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

export type AuthenticationDecision =
  | {
      readonly context: HotUpdaterRequestExecutionContext;
      readonly kind: "authenticated";
    }
  | { readonly kind: "response"; readonly response: Response };

function opaqueResponse(status: 401 | 500 | 503): Response {
  let error: string;
  switch (status) {
    case 401:
      error = "Unauthorized";
      break;
    case 503:
      error = "Service unavailable";
      break;
    default:
      error = "Internal server error";
  }
  return Response.json(
    { error },
    {
      headers: { "cache-control": "private, no-store" },
      status,
    },
  );
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (!ownKeys.every((key): key is string => typeof key === "string")) {
    return false;
  }
  const actual = ownKeys.sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function parsePrincipalString(
  value: unknown,
  maximumBytes: number,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !value.isWellFormed() ||
    hasControlCharacter(value) ||
    textEncoder.encode(value).byteLength > maximumBytes
  ) {
    return undefined;
  }
  return value;
}

function parsePrincipal(value: unknown): HotUpdaterPrincipal | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !hasExactKeys(value, ["issuer", "subject"])
  ) {
    return undefined;
  }
  const issuer = parsePrincipalString(Reflect.get(value, "issuer"), 2_048);
  const subject = parsePrincipalString(Reflect.get(value, "subject"), 1_024);
  if (issuer === undefined || subject === undefined) {
    return undefined;
  }
  return Object.freeze({ issuer, subject });
}

function parseAuthenticationResult(
  value: unknown,
): HotUpdaterAuthenticationResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const kind = Reflect.get(value, "kind");
  if (kind === "anonymous" || kind === "unavailable") {
    if (!hasExactKeys(value, ["kind"])) {
      return undefined;
    }
    return Object.freeze({ kind });
  }
  if (kind !== "authenticated" || !hasExactKeys(value, ["kind", "principal"])) {
    return undefined;
  }
  const principal = parsePrincipal(Reflect.get(value, "principal"));
  if (principal === undefined) {
    return undefined;
  }
  return Object.freeze({ kind, principal });
}

function freezeRoute(route: HotUpdaterMatchedRoute): HotUpdaterMatchedRoute {
  return Object.freeze({
    access: Object.freeze({ ...route.access }),
    id: route.id,
    method: route.method,
    params: Object.freeze({ ...route.params }),
    pattern: route.pattern,
  });
}

export const selectAuthenticationProvider = (input: {
  readonly providers: readonly HotUpdaterAuthenticationProvider[];
  readonly routes: readonly {
    readonly access: HotUpdaterMatchedRoute["access"];
    readonly id: string;
  }[];
}): HotUpdaterAuthenticationProvider | undefined => {
  if (input.providers.length > 1) {
    throw new HotUpdaterConstructionError("MULTIPLE_AUTHENTICATION_PROVIDERS", {
      providerIds: Object.freeze(input.providers.map(({ id }) => id).sort()),
    });
  }
  const provider = input.providers[0];
  const protectedRoute = input.routes.find(
    ({ access }) => access.kind === "protected",
  );
  if (provider === undefined && protectedRoute !== undefined) {
    throw new HotUpdaterConstructionError(
      "PROTECTED_ROUTE_WITHOUT_AUTHENTICATION",
      { routeId: protectedRoute.id },
    );
  }
  return provider;
};

export const authenticateMatchedRoute = async (input: {
  readonly headers: Headers;
  readonly provider?: HotUpdaterAuthenticationProvider;
  readonly route: HotUpdaterMatchedRoute;
  readonly signal: AbortSignal;
  readonly url: URL;
}): Promise<AuthenticationDecision> => {
  const route = freezeRoute(input.route);
  if (route.access.kind === "public") {
    return Object.freeze({
      context: Object.freeze({
        principal: undefined,
        route: Object.freeze({
          ...route,
          access: Object.freeze({ kind: "public" }),
        }),
      }),
      kind: "authenticated",
    });
  }
  if (input.provider === undefined) {
    throw new HotUpdaterConstructionError(
      "PROTECTED_ROUTE_WITHOUT_AUTHENTICATION",
      { routeId: route.id },
    );
  }

  try {
    const rawResult: unknown = await input.provider.authenticate({
      headers: new Headers(input.headers),
      method: route.method,
      route,
      signal: input.signal,
      url: new URL(input.url),
    });
    const result = parseAuthenticationResult(rawResult);
    switch (result?.kind) {
      case "anonymous":
        return { kind: "response", response: opaqueResponse(401) };
      case "unavailable":
        return { kind: "response", response: opaqueResponse(503) };
      case "authenticated":
        return Object.freeze({
          context: Object.freeze({
            principal: result.principal,
            route: Object.freeze({
              ...route,
              access: Object.freeze({ kind: "protected" }),
            }),
          }),
          kind: "authenticated",
        });
      default:
        return { kind: "response", response: opaqueResponse(500) };
    }
  } catch {
    return { kind: "response", response: opaqueResponse(500) };
  }
};
