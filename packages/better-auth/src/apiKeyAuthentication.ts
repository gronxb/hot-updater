import type {
  HotUpdaterAuthenticationInput,
  HotUpdaterAuthenticationProvider,
} from "@hot-updater/server/internal/first-party-plugin";

import { isUnavailableError } from "./outage";

const DEFAULT_API_KEY_HEADER = "x-api-key";
const MAXIMUM_API_KEY_BYTES = 4_096;
const MAXIMUM_CONFIG_ID_BYTES = 255;
const MAXIMUM_REFERENCE_ID_BYTES = 1_024;
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const textEncoder = new TextEncoder();

type BetterAuthPermissions = Readonly<Record<string, readonly string[]>>;

type BetterAuthVerifyApiKeyInput = {
  readonly body: {
    readonly configId: string;
    readonly key: string;
    readonly permissions?: Record<string, string[]>;
  };
};

export type BetterAuthApiKeyConfiguredInstance = {
  readonly api: {
    readonly verifyApiKey: (
      input: BetterAuthVerifyApiKeyInput,
    ) => Promise<unknown>;
  };
};

export type BetterAuthApiKeyConfiguration = {
  readonly configId: string;
  readonly headerName?: string;
  readonly requiredPermissions?: BetterAuthPermissions;
};

type ParsedApiKeyConfiguration = {
  readonly configId: string;
  readonly headerName: string;
  readonly requiredPermissions?: BetterAuthPermissions;
};

type VerificationDecision =
  | { readonly kind: "rejected" }
  | { readonly kind: "verified"; readonly referenceId: string };

class BetterAuthPluginConfigurationError extends Error {
  readonly field: "configId" | "headerName";

  constructor(field: "configId" | "headerName") {
    super(`Better Auth API-key ${field} is invalid.`);
    this.name = "BetterAuthPluginConfigurationError";
    this.field = field;
  }
}

class BetterAuthVerificationContractError extends Error {
  constructor() {
    super("Better Auth returned an invalid API-key verification result.");
    this.name = "BetterAuthVerificationContractError";
  }
}

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
};

const isApiKeyCredential = (value: string | null): value is string =>
  value !== null &&
  value.length > 0 &&
  value.isWellFormed() &&
  !value.includes(",") &&
  !hasControlCharacter(value) &&
  textEncoder.encode(value).byteLength <= MAXIMUM_API_KEY_BYTES;

const isReferenceId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value === value.trim() &&
  value.isWellFormed() &&
  !hasControlCharacter(value) &&
  textEncoder.encode(value).byteLength <= MAXIMUM_REFERENCE_ID_BYTES;

const isConfigId = (value: string): boolean =>
  value.length > 0 &&
  value === value.trim() &&
  value.isWellFormed() &&
  !hasControlCharacter(value) &&
  textEncoder.encode(value).byteLength <= MAXIMUM_CONFIG_ID_BYTES;

const readVerificationProperty = (
  value: object,
  property: "key" | "referenceId" | "valid",
): unknown => {
  try {
    return Reflect.get(value, property);
  } catch {
    throw new BetterAuthVerificationContractError();
  }
};

const parseVerificationDecision = (value: unknown): VerificationDecision => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BetterAuthVerificationContractError();
  }

  const valid = readVerificationProperty(value, "valid");
  if (valid === false) return Object.freeze({ kind: "rejected" });
  if (valid !== true) throw new BetterAuthVerificationContractError();

  const key = readVerificationProperty(value, "key");
  if (typeof key !== "object" || key === null || Array.isArray(key)) {
    throw new BetterAuthVerificationContractError();
  }
  const referenceId = readVerificationProperty(key, "referenceId");
  if (!isReferenceId(referenceId)) {
    throw new BetterAuthVerificationContractError();
  }
  return Object.freeze({ kind: "verified", referenceId });
};

const parseConfiguration = (
  value: BetterAuthApiKeyConfiguration,
): ParsedApiKeyConfiguration => {
  const headerName = value.headerName ?? DEFAULT_API_KEY_HEADER;
  if (!headerNamePattern.test(headerName)) {
    throw new BetterAuthPluginConfigurationError("headerName");
  }
  if (!isConfigId(value.configId)) {
    throw new BetterAuthPluginConfigurationError("configId");
  }
  return Object.freeze({
    configId: value.configId,
    headerName,
    ...(value.requiredPermissions === undefined
      ? {}
      : { requiredPermissions: value.requiredPermissions }),
  });
};

const clonePermissions = (
  permissions: BetterAuthPermissions,
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(permissions).map(([resource, actions]) => [
      resource,
      [...actions],
    ]),
  );

const assertNever = (_value: never): never => {
  throw new BetterAuthVerificationContractError();
};

export const createApiKeyAuthenticationProvider = (
  auth: BetterAuthApiKeyConfiguredInstance,
  configured: BetterAuthApiKeyConfiguration,
): HotUpdaterAuthenticationProvider => {
  const configuration = parseConfiguration(configured);

  return Object.freeze({
    id: "better-auth-api-key",
    async authenticate(input: HotUpdaterAuthenticationInput) {
      const key = input.headers.get(configuration.headerName);
      if (!isApiKeyCredential(key)) {
        return Object.freeze({ kind: "anonymous" });
      }

      try {
        const verification = await auth.api.verifyApiKey({
          body: {
            configId: configuration.configId,
            key,
            ...(configuration.requiredPermissions === undefined
              ? {}
              : {
                  permissions: clonePermissions(
                    configuration.requiredPermissions,
                  ),
                }),
          },
        });
        const decision = parseVerificationDecision(verification);
        switch (decision.kind) {
          case "rejected":
            return Object.freeze({ kind: "anonymous" });
          case "verified":
            return Object.freeze({
              kind: "authenticated",
              principal: Object.freeze({
                issuer: "better-auth-api-key",
                subject: decision.referenceId,
              }),
            });
          default:
            return assertNever(decision);
        }
      } catch (error) {
        if (isUnavailableError(error)) {
          return Object.freeze({ kind: "unavailable" });
        }
        throw error;
      }
    },
  });
};
