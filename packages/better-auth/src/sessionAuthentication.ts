import type {
  HotUpdaterAuthenticationInput,
  HotUpdaterAuthenticationProvider,
} from "@hot-updater/server/internal/first-party-plugin";

import { isUnavailableError } from "./outage";

export type BetterAuthSession = {
  readonly session: unknown;
  readonly user: {
    readonly id: string;
  };
};

export type BetterAuthSessionConfiguredInstance = {
  readonly api: {
    readonly getSession: (input: {
      readonly headers: Headers;
    }) => Promise<BetterAuthSession | null>;
  };
};

export const createSessionAuthenticationProvider = (
  auth: BetterAuthSessionConfiguredInstance,
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
