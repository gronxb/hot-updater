import type { HotUpdaterContext } from "@hot-updater/plugin-core";

export const serverPluginBrand: unique symbol = Symbol(
  "@hot-updater/server/plugin",
);

export interface HotUpdaterServerPlugin {
  readonly [serverPluginBrand]: undefined;
}

export type HotUpdaterHttpMethod = "DELETE" | "GET" | "PATCH" | "POST";

export type HotUpdaterRouteAccess =
  | { readonly kind: "public" }
  | { readonly kind: "protected" };

export type HotUpdaterMatchedRoute = {
  readonly access: HotUpdaterRouteAccess;
  readonly id: string;
  readonly method: HotUpdaterHttpMethod;
  readonly params: Readonly<Record<string, string>>;
  readonly pattern: `/${string}`;
};

export type HotUpdaterPrincipal = {
  readonly issuer: string;
  readonly subject: string;
};

export type HotUpdaterAuthenticationResult =
  | {
      readonly kind: "authenticated";
      readonly principal: HotUpdaterPrincipal;
    }
  | { readonly kind: "anonymous" }
  | { readonly kind: "unavailable" };

export type HotUpdaterAuthenticationInput = {
  readonly headers: Headers;
  readonly method: HotUpdaterHttpMethod;
  readonly route: HotUpdaterMatchedRoute;
  readonly signal: AbortSignal;
  readonly url: URL;
};

export interface HotUpdaterAuthenticationProvider {
  readonly id: string;
  authenticate(
    input: HotUpdaterAuthenticationInput,
  ): Promise<HotUpdaterAuthenticationResult>;
}

export type HotUpdaterRequestExecutionContext =
  | {
      readonly principal: undefined;
      readonly route: HotUpdaterMatchedRoute & {
        readonly access: { readonly kind: "public" };
      };
    }
  | {
      readonly principal: HotUpdaterPrincipal;
      readonly route: HotUpdaterMatchedRoute & {
        readonly access: { readonly kind: "protected" };
      };
    };

export type HotUpdaterRouteContext<TContext = unknown> =
  HotUpdaterRequestExecutionContext & {
    readonly headers: Headers;
    readonly platformContext?: HotUpdaterContext<TContext>;
    readonly signal: AbortSignal;
    readonly url: URL;
  };

export interface HotUpdaterRequestParser<TInput> {
  parse(request: Request): Promise<TInput>;
}

export interface HotUpdaterServerRoute<TInput = unknown, TContext = unknown> {
  readonly access: HotUpdaterRouteAccess;
  readonly id: string;
  readonly input?: HotUpdaterRequestParser<TInput>;
  readonly method: HotUpdaterHttpMethod;
  readonly path: `/${string}`;
  handle(
    context: HotUpdaterRouteContext<TContext>,
    input: TInput,
  ): Promise<Response>;
}
