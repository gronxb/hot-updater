import type {
  HotUpdaterAuthenticationInput,
  HotUpdaterAuthenticationProvider,
} from "@hot-updater/server/internal/first-party-plugin";

import { isCredentialRejectionError } from "./credentialRejection";
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

class BetterAuthSessionContractError extends Error {
  constructor() {
    super("Better Auth returned an invalid session.");
    this.name = "BetterAuthSessionContractError";
  }
}

const isUserId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value === value.trim() &&
  value.isWellFormed();

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
        if (!isUserId(result.user.id)) {
          throw new BetterAuthSessionContractError();
        }
        return Object.freeze({
          kind: "authenticated",
          principal: Object.freeze({
            issuer: "better-auth",
            subject: result.user.id,
          }),
        });
      } catch (error) {
        if (isCredentialRejectionError(error)) {
          return Object.freeze({ kind: "anonymous" });
        }
        if (isUnavailableError(error)) {
          return Object.freeze({ kind: "unavailable" });
        }
        throw error;
      }
    },
  });
