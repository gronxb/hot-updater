import {
  defineFirstPartyFeatureManifest,
  type HotUpdaterAuthenticationInput,
  type HotUpdaterAuthenticationProvider,
  type NoFeatureApiKind,
} from "@hot-updater/server/internal/first-party-plugin";

import packageJson from "../package.json" with { type: "json" };

export type BetterAuthSession = {
  readonly session: unknown;
  readonly user: {
    readonly id: string;
  };
};

export type BetterAuthConfiguredInstance = {
  readonly api: {
    readonly getSession: (input: {
      readonly headers: Headers;
    }) => Promise<BetterAuthSession | null>;
  };
};

export type BetterAuthPluginOptions = {
  readonly auth: BetterAuthConfiguredInstance;
};

const isUnavailableError = (error: unknown): boolean => {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  ) {
    return false;
  }
  try {
    const status = Reflect.get(error, "status");
    return (
      status === 503 ||
      status === "SERVICE_UNAVAILABLE" ||
      Reflect.get(error, "statusCode") === 503
    );
  } catch {
    return false;
  }
};

const createAuthenticationProvider = (
  auth: BetterAuthConfiguredInstance,
): HotUpdaterAuthenticationProvider =>
  Object.freeze({
    id: "better-auth",
    async authenticate(input: HotUpdaterAuthenticationInput) {
      try {
        const result = await auth.api.getSession({
          headers: new Headers(input.headers),
        });
        if (result === null) return Object.freeze({ kind: "anonymous" });
        return Object.freeze({
          kind: "authenticated",
          principal: Object.freeze({
            issuer: "better-auth",
            subject: result.user.id,
          }),
        });
      } catch (error) {
        if (isUnavailableError(error)) {
          return Object.freeze({ kind: "unavailable" });
        }
        throw error;
      }
    },
  });

export const betterAuthPlugin = (options: BetterAuthPluginOptions) => {
  const authentication = createAuthenticationProvider(options.auth);
  return defineFirstPartyFeatureManifest<
    "better-auth",
    NoFeatureApiKind,
    Record<never, never>
  >({
    aliases: {},
    id: "better-auth",
    namespace: "better-auth",
    setup: () => ({ authentication }),
    version: packageJson.version,
  });
};
