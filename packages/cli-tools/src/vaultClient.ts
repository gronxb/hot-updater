import type { VaultSecret, VaultSecretKind } from "@hot-updater/server/plugins";

import { getHotUpdaterEnvValue } from "./hotUpdaterEnv";
import { registerSecretValue } from "./secretMasking";

/**
 * The environment variables that connect the CLI to the Console's vault:
 * the Console's URL and a vault token. Nothing else is needed, and there is
 * no sign-in.
 */
export const VAULT_CONNECTION_ENV_NAMES = {
  url: "HOT_UPDATER_CONSOLE_URL",
  token: "HOT_UPDATER_VAULT_TOKEN",
} as const;

/** Where the Console serves the vault, beneath its URL. */
const VAULT_PATH = "/_hot-updater/vault/v1";

/** Names one resolve request takes, as the Console does. */
const MAX_RESOLVE_NAMES = 100;

const VAULT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** A secret's metadata, as the Console lists it, without its value. */
export type VaultSecretMetadata = VaultSecret;

/** A secret's value, as the Console resolves it. */
export interface ResolvedVaultSecret {
  readonly name: string;
  readonly kind: VaultSecretKind;
  readonly version: number;
  readonly value: unknown;
}

/**
 * A request the Console refused or never answered. `status` is the HTTP
 * status, absent when the Console was not reached, and `code` the Console's
 * error code, such as `forbidden`.
 */
export class VaultRequestError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(
    message: string,
    options: { status?: number; code?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "VaultRequestError";
    this.status = options.status;
    this.code = options.code;
  }
}

/** The Console's vault, reached with a vault token. */
export interface VaultClient {
  /** The Console's URL, as messages name it. */
  readonly url: string;
  /** `GET /secrets`: the secrets the token's scope reaches, without values. */
  list(): Promise<readonly VaultSecretMetadata[]>;
  /**
   * `POST /resolve`: the values of the secrets named, in one request, for a
   * token whose scope allows `read` on each. A name no secret has is in
   * `missing`.
   */
  resolve(names: readonly string[]): Promise<{
    readonly secrets: readonly ResolvedVaultSecret[];
    readonly missing: readonly string[];
  }>;
  /**
   * `PUT /secrets/:name`: stores `value` as the secret's next version, for a
   * token whose scope allows `write` on it. The Console seals the value with
   * its master key, so the plaintext is sent only to the Console, and
   * answers with the secret's metadata, never its value.
   */
  put(input: {
    readonly name: string;
    readonly kind: VaultSecretKind;
    readonly value: unknown;
    /**
     * The version the secret must be at, refused with a 409 otherwise: 0
     * stores only a new secret, never replacing one under the name.
     */
    readonly expectedVersion?: number;
  }): Promise<VaultSecretMetadata>;
}

export interface VaultConnection {
  readonly url: string;
  readonly token: string;
}

/**
 * The connection `HOT_UPDATER_CONSOLE_URL` and `HOT_UPDATER_VAULT_TOKEN` set,
 * read as `getHotUpdaterEnvValue` reads them, or the names of those unset.
 */
export const readVaultConnection = (
  env: Readonly<Record<string, string>> = {},
):
  | { readonly ok: true; readonly connection: VaultConnection }
  | { readonly ok: false; readonly missing: readonly string[] } => {
  const url = getHotUpdaterEnvValue(env, VAULT_CONNECTION_ENV_NAMES.url);
  const token = getHotUpdaterEnvValue(env, VAULT_CONNECTION_ENV_NAMES.token);
  if (url === undefined || token === undefined) {
    return {
      ok: false,
      missing: [
        ...(url === undefined ? [VAULT_CONNECTION_ENV_NAMES.url] : []),
        ...(token === undefined ? [VAULT_CONNECTION_ENV_NAMES.token] : []),
      ],
    };
  }
  return { ok: true, connection: { url, token } };
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The Console's URL without a trailing slash, or a thrown error. The token
 * and the values it reaches travel over HTTPS, or plain HTTP only to this
 * machine, such as a Console on localhost.
 */
const consoleUrlOf = (url: string): string => {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (
    parsed === undefined ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
  ) {
    throw new VaultRequestError(
      `${VAULT_CONNECTION_ENV_NAMES.url} is the Console's URL, such as https://console.example.com, and "${url}" is not one.`,
    );
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new VaultRequestError(
      `${VAULT_CONNECTION_ENV_NAMES.url} is ${parsed.origin}, and the vault token and secrets travel only over HTTPS, or HTTP to localhost: use the Console's https:// URL.`,
    );
  }
  return parsed.href.replace(/\/+$/u, "");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `{ error: { code, message } }` of a refusal, when the body is one. */
const refusalOf = async (
  response: Response,
): Promise<{ readonly code?: string; readonly message?: string }> => {
  const body: unknown = await response.json().catch(() => undefined);
  const error = isRecord(body) ? body.error : undefined;
  if (!isRecord(error)) return {};
  return {
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.message === "string" ? { message: error.message } : {}),
  };
};

const describeRefusal = (
  url: string,
  status: number,
  { code, message }: { readonly code?: string; readonly message?: string },
): string => {
  if (status === 401) {
    return `The Console at ${url} refused ${VAULT_CONNECTION_ENV_NAMES.token}: ${message ?? "the token is not valid."}`;
  }
  if (status === 403) {
    return `The Console at ${url} refused the request: ${message ?? "the vault token's scope does not allow it."}`;
  }
  if (status === 404 && code === undefined) {
    return `${url} serves no vault at ${VAULT_PATH}/: check that ${VAULT_CONNECTION_ENV_NAMES.url} is the Console's URL.`;
  }
  return `The Console at ${url} answered ${status}${code === undefined ? "" : ` ${code}`}: ${message ?? "the vault could not serve the request."}`;
};

/**
 * A client for the vault the Console serves at `/_hot-updater/vault/v1/`,
 * authenticated by `token` as `Authorization: Bearer`. The token is masked
 * in logs. Each refusal is a `VaultRequestError` naming the Console's URL.
 */
export const createVaultClient = ({
  url,
  token,
  fetch = globalThis.fetch,
}: VaultConnection & {
  /** The fetch requests go through; defaults to the global one. */
  readonly fetch?: typeof globalThis.fetch;
}): VaultClient => {
  const base = consoleUrlOf(url);
  registerSecretValue(token);

  const request = async (
    method: "GET" | "POST" | "PUT",
    route: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetch(`${base}${VAULT_PATH}${route}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new VaultRequestError(
        `Could not reach the Console at ${base} (${reason}).`,
        { cause: error },
      );
    }
    if (!response.ok) {
      const refusal = await refusalOf(response);
      throw new VaultRequestError(
        describeRefusal(base, response.status, refusal),
        {
          status: response.status,
          ...(refusal.code === undefined ? {} : { code: refusal.code }),
        },
      );
    }
    const parsed: unknown = await response.json().catch(() => undefined);
    if (!isRecord(parsed)) {
      throw new VaultRequestError(
        `The Console at ${base} answered ${route} with no vault response: check that ${VAULT_CONNECTION_ENV_NAMES.url} is the Console's URL.`,
        { status: response.status },
      );
    }
    return parsed;
  };

  const malformed = (route: string) =>
    new VaultRequestError(
      `The Console at ${base} answered ${route} with a response this CLI does not read.`,
    );

  return Object.freeze({
    url: base,

    async list() {
      const { secrets } = await request("GET", "/secrets");
      if (!Array.isArray(secrets)) throw malformed("/secrets");
      return secrets as VaultSecretMetadata[];
    },

    async resolve(names) {
      const unique = [...new Set(names)];
      const invalid = unique.filter((name) => !VAULT_NAME_PATTERN.test(name));
      if (invalid.length > 0) {
        throw new VaultRequestError(
          `A vault secret's name is 1-64 letters, digits, dots, dashes, or underscores, and ${invalid.map((name) => `"${name}"`).join(", ")} ${invalid.length === 1 ? "is" : "are"} not.`,
        );
      }
      const secrets: ResolvedVaultSecret[] = [];
      const missing: string[] = [];
      for (let at = 0; at < unique.length; at += MAX_RESOLVE_NAMES) {
        const body = await request("POST", "/resolve", {
          names: unique.slice(at, at + MAX_RESOLVE_NAMES),
        });
        if (!Array.isArray(body.secrets) || !Array.isArray(body.errors)) {
          throw malformed("/resolve");
        }
        for (const secret of body.secrets as unknown[]) {
          if (
            !isRecord(secret) ||
            typeof secret.name !== "string" ||
            typeof secret.kind !== "string"
          ) {
            throw malformed("/resolve");
          }
          secrets.push(secret as unknown as ResolvedVaultSecret);
        }
        for (const error of body.errors as unknown[]) {
          if (isRecord(error) && typeof error.name === "string") {
            missing.push(error.name);
          }
        }
      }
      return { secrets, missing };
    },

    async put({ name, kind, value, expectedVersion }) {
      if (!VAULT_NAME_PATTERN.test(name)) {
        throw new VaultRequestError(
          `A vault secret's name is 1-64 letters, digits, dots, dashes, or underscores, and "${name}" is not.`,
        );
      }
      const route = `/secrets/${encodeURIComponent(name)}`;
      const { secret } = await request("PUT", route, {
        kind,
        value,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      });
      if (!isRecord(secret) || typeof secret.name !== "string") {
        throw malformed(route);
      }
      return secret as unknown as VaultSecretMetadata;
    },
  } satisfies VaultClient);
};
