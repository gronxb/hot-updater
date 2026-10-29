import { createHash } from "node:crypto";

import { isTokenCredential, type TokenCredential } from "@azure/core-auth";
import type { SecretClient } from "@azure/keyvault-secrets";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

export interface KeyVaultOptions {
  /**
   * The vault's name, which reads `https://<vaultName>.vault.azure.net`.
   * Set it or `vaultUrl`.
   */
  readonly vaultName?: string;
  /**
   * The vault's URL, such as `https://my-vault.vault.azure.net`, for a
   * vault outside Azure's public cloud. An HTTPS URL on a loopback address,
   * such as a local emulator's, skips the check that the sign-in challenge
   * names the vault's domain.
   */
  readonly vaultUrl?: string;
  /**
   * Put before each name to make its secret's name, so `secret:asc-api-key`
   * reads the secret `hot-updater-asc-api-key`. Letters, digits, and `-`.
   *
   * @default "hot-updater-"
   */
  readonly prefix?: string;
  /**
   * The Microsoft Entra identity to sign in with, such as a
   * `ClientSecretCredential` from `@azure/identity`. Without it,
   * `DefaultAzureCredential`: `AZURE_CLIENT_ID` and its siblings, or the
   * federated token `azure/login` leaves in CI, then `az login` on your
   * machine, or a managed identity.
   */
  readonly credential?: TokenCredential;
}

const NAME = "keyVault";
const VAULT_NAME_PATTERN = /^[A-Za-z](?!.*--)[A-Za-z0-9-]{1,22}[A-Za-z0-9]$/u;
/** The characters Key Vault takes in a secret's name. */
const PREFIX_PATTERN = /^[A-Za-z0-9-]*$/u;
/** Names Key Vault keeps as they are: lower case, digits, single hyphens. */
const PLAIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_SECRET_NAME_LENGTH = 127;
/** Key Vault's limit on a value, in characters: it refuses one more. */
const MAX_SECRET_LENGTH = 25_600;
/** The tag that keeps the name a secret holds, which a mapped name hides. */
const NAME_TAG = "hot-updater-name";

/** Errors of `@azure/identity` finding no identity, or failing to sign in. */
const NO_CREDENTIAL_ERRORS = new Set([
  "AggregateAuthenticationError",
  "AuthenticationRequiredError",
  "CredentialUnavailableError",
]);

const SIGN_IN_HINT =
  "In CI, sign in with azure/login; on your machine, run az login, or set AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET";

const READ_ROLE = "Key Vault Secrets User";
const WRITE_ROLE = "Key Vault Secrets Officer";

interface RestErrorLike {
  readonly name?: string;
  readonly statusCode?: number;
  readonly code?: string;
  readonly details?: {
    readonly error?: {
      readonly innerError?: { readonly code?: string };
      readonly innererror?: { readonly code?: string };
    };
  };
}

const errorName = (error: unknown) =>
  error instanceof Error ? error.name : "";

/** The message's first line: Key Vault's next lines name the caller's IDs. */
const errorMessage = (error: unknown) =>
  (
    (error instanceof Error ? error.message : String(error)).split(
      /\r?\n/u,
      1,
    )[0] ?? ""
  ).replace(/\.+$/u, "");

const innerCode = (error: unknown) => {
  const inner = (error as RestErrorLike)?.details?.error;
  return inner?.innerError?.code ?? inner?.innererror?.code;
};

const statusOf = (error: unknown) => (error as RestErrorLike)?.statusCode;

const isLoopback = (hostname: string) =>
  new Set(["localhost", "127.0.0.1", "[::1]"]).has(hostname);

const resolveVaultUrl = (vaultName?: string, vaultUrl?: string) => {
  if ((vaultName === undefined) === (vaultUrl === undefined)) {
    throw new Error(`${NAME} needs a vaultName or a vaultUrl, and not both.`);
  }
  if (vaultName !== undefined) {
    if (typeof vaultName !== "string" || !VAULT_NAME_PATTERN.test(vaultName)) {
      throw new Error(
        `${NAME} needs a vault name of 3 to 24 letters, digits, and single hyphens, starting with a letter, and ${JSON.stringify(vaultName)} is not one.`,
      );
    }
    return new URL(`https://${vaultName.toLowerCase()}.vault.azure.net`);
  }
  let url: URL;
  try {
    url = new URL(String(vaultUrl).trim());
  } catch {
    throw new Error(`${NAME} vaultUrl must be a valid URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      `${NAME} vaultUrl must be an HTTPS origin, such as https://my-vault.vault.azure.net, without credentials, a path, a query, or a fragment.`,
    );
  }
  return url;
};

/** Masks a value in the CLI's output, which loads `@hot-updater/cli-tools`. */
const mask = async (values: readonly (string | undefined)[]) => {
  const { registerSecretValue } = await import("@hot-updater/cli-tools");
  for (const value of values) if (value) registerSecretValue(value);
};

/** `credential`, with each access token it returns masked. */
const maskTokens = (credential: TokenCredential): TokenCredential => ({
  getToken: async (scopes, options) => {
    const token = await credential.getToken(scopes, options);
    await mask([token?.token]);
    return token;
  },
});

/**
 * The Key Vault secret name of `name`, after `prefix`. Key Vault takes
 * only letters, digits, and `-` in a name, and matches names without
 * regard to case, so:
 *
 * - a name of lower-case letters and digits in words joined by single
 *   hyphens, such as `asc-api-key`, is kept as it is;
 * - any other name, such as `CLOUDFLARE_API_TOKEN` or `upload.keystore`,
 *   becomes its lower-cased words joined by `-`, then `--` and the first 10
 *   hex digits of the SHA-256 of the exact name:
 *   `cloudflare-api-token--<hash>`.
 *
 * A kept name never holds `--` and a mapped one always does, so no two
 * names share a secret, and `CLOUDFLARE_API_TOKEN` and
 * `cloudflare-api-token` stay apart. Each secret `set` stores is tagged
 * `hot-updater-name` with the name it holds.
 */
const keyVaultSecretName = (name: string, prefix = "hot-updater-") => {
  if (PLAIN_NAME_PATTERN.test(name)) return `${prefix}${name}`;
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 10);
  return `${prefix}${words}--${hash}`;
};

/**
 * Secrets from Azure Key Vault: each name is the secret `<prefix><name>`
 * of the vault, `hot-updater-asc-api-key` for `asc-api-key`, with any
 * other name mapped as `keyVaultSecretName` says, read at its current
 * version. `set` adds a new version of
 * the secret, which creates it when it does not exist; Key Vault keeps the
 * older versions. A name whose secret was deleted and is still recoverable
 * reads as missing, and `set` on it fails with the `az` commands that
 * recover or purge it. `@azure/keyvault-secrets`, and `@azure/identity`
 * without a `credential`, load on the first read or write, so a config
 * that only uses `azureBlobStorage` never loads them.
 *
 * @example
 * secrets: keyVault({ vaultName: "my-vault" })
 */
export const keyVault = ({
  credential,
  prefix = "hot-updater-",
  vaultName,
  vaultUrl,
}: KeyVaultOptions): SecretsAdapter => {
  // Checked on first use, so a config loads without its settings.
  const vault = () => {
    const url = resolveVaultUrl(vaultName, vaultUrl);
    if (typeof prefix !== "string" || !PREFIX_PATTERN.test(prefix)) {
      throw new Error(`${NAME}'s prefix takes letters, digits, and - only.`);
    }
    return url;
  };

  const secretName = (name: string) => {
    vault();
    const id = keyVaultSecretName(name, prefix);
    if (id.length > MAX_SECRET_NAME_LENGTH) {
      throw new Error(
        `${NAME} cannot name a secret ${JSON.stringify(id)} for ${JSON.stringify(name)}: Key Vault takes up to ${MAX_SECRET_NAME_LENGTH} characters.`,
      );
    }
    return id;
  };

  /** The vault's name, for the az commands messages suggest. */
  const vaultLabel = () => vault().hostname.split(".")[0];

  let opened: Promise<SecretClient> | undefined;
  const open = () => {
    const url = vault();
    if (credential !== undefined && !isTokenCredential(credential)) {
      throw new Error(
        `${NAME} credential must be a TokenCredential, such as one from @azure/identity.`,
      );
    }
    opened ??= Promise.all([
      import("@azure/keyvault-secrets"),
      credential ??
        import("@azure/identity").then(
          ({ DefaultAzureCredential }) => new DefaultAzureCredential(),
        ),
    ])
      .then(
        ([sdk, signWith]) =>
          new sdk.SecretClient(url.origin, maskTokens(signWith), {
            // An emulator's challenge names its own host, not a subdomain.
            disableChallengeResourceVerification: isLoopback(url.hostname),
          }),
      )
      .catch((error: unknown) => {
        opened = undefined;
        throw error;
      });
    return opened;
  };

  const describeFailure = (
    verb: string,
    id: string,
    error: unknown,
    role: string,
  ) => {
    const name = errorName(error);
    const status = statusOf(error);
    const code = innerCode(error) ?? (error as RestErrorLike)?.code;
    const detail = `${code || name || "Error"}${status ? ` (${status})` : ""}: ${errorMessage(error)}`;
    if (NO_CREDENTIAL_ERRORS.has(name)) {
      return new Error(
        `${NAME} found no usable Azure identity to ${verb} ${JSON.stringify(id)} (${errorMessage(error)}). ${SIGN_IN_HINT}.`,
        { cause: error },
      );
    }
    if (status === 401) {
      return new Error(
        `Azure Key Vault refused the sign-in to ${verb} ${JSON.stringify(id)}, ${detail}. Sign in again. ${SIGN_IN_HINT}.`,
        { cause: error },
      );
    }
    if (code === "SecretDisabled") {
      return new Error(
        `Azure Key Vault cannot ${verb} ${JSON.stringify(id)}: its current version is disabled. Enable it, or store a new value.`,
        { cause: error },
      );
    }
    if (status === 403) {
      return new Error(
        `Azure Key Vault refused to ${verb} ${JSON.stringify(id)}, ${detail}. The Azure identity needs the ${role} role on the vault, or, on a vault with access policies, the secret permissions ${role === READ_ROLE ? "get" : "get and set"}; a firewall may also refuse this network.`,
        { cause: error },
      );
    }
    if (
      code === "ObjectIsBeingDeleted" ||
      /being deleted/iu.test(errorMessage(error))
    ) {
      return new Error(
        `Azure Key Vault cannot ${verb} ${JSON.stringify(id)}: it is being deleted. Try again in a minute.`,
        { cause: error },
      );
    }
    if (status === 409 || code === "ObjectIsDeletedButRecoverable") {
      return new Error(
        `Azure Key Vault cannot ${verb} ${JSON.stringify(id)}: it was deleted and is still recoverable. Recover it with az keyvault secret recover --vault-name ${vaultLabel()} --name ${id}, or purge it with az keyvault secret purge --vault-name ${vaultLabel()} --name ${id}.`,
        { cause: error },
      );
    }
    return new Error(
      `Azure Key Vault failed to ${verb} ${JSON.stringify(id)}, ${detail}.`,
      { cause: error },
    );
  };

  const read = async (
    client: SecretClient,
    id: string,
  ): Promise<string | undefined> => {
    let value: string | undefined;
    try {
      ({ value } = await client.getSecret(id));
    } catch (error) {
      // SecretNotFound, also for a deleted secret that is still recoverable.
      // A 404 of another code, such as a URL that is not a vault, throws.
      if (
        statusOf(error) === 404 &&
        /NotFound/u.test((error as RestErrorLike).code ?? "") &&
        !/disabled/iu.test(errorMessage(error))
      ) {
        return undefined;
      }
      throw describeFailure("read", id, error, READ_ROLE);
    }
    await mask([value]);
    return value;
  };

  return {
    name: NAME,
    // One request per name, in parallel: Key Vault reads one secret a call.
    get: async (names) => {
      const unique = [...new Set(names)];
      const ids = unique.map(secretName);
      // No prototype: a secret may be named __proto__.
      const result: Record<string, string | undefined> = Object.create(null);
      if (unique.length === 0) return result;
      const client = await open();
      const values = await Promise.all(ids.map((id) => read(client, id)));
      unique.forEach((name, index) => {
        result[name] = values[index];
      });
      return result;
    },
    set: async (name, value) => {
      const id = secretName(name);
      if (typeof value !== "string" || value === "") {
        throw new Error(`${NAME} cannot store an empty ${id}.`);
      }
      if (value.length > MAX_SECRET_LENGTH) {
        throw new Error(
          `${NAME} cannot store ${id}: Key Vault takes up to ${MAX_SECRET_LENGTH} characters per secret, and this value has ${value.length}.`,
        );
      }
      await mask([value]);
      const client = await open();
      try {
        await client.setSecret(id, value, { tags: { [NAME_TAG]: name } });
      } catch (error) {
        throw describeFailure("write", id, error, WRITE_ROLE);
      }
    },
    describe: (name) => {
      let url: string;
      try {
        url = vault().origin;
      } catch {
        url = String(vaultUrl ?? vaultName);
      }
      return `the secret ${JSON.stringify(keyVaultSecretName(name, prefix))} in Azure Key Vault (${url})`;
    },
  };
};
