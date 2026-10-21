import type {
  VaultMasterKeys,
  VaultRewrapResult,
  VaultSecret,
  VaultSecretKind,
  VaultStatus,
  VaultToken,
  VaultTokenScope,
} from "@hot-updater/server/plugins";
import { createServerFn } from "@tanstack/react-start";

import { consoleAccess } from "./console-access";
import { VAULT_SECRET_KIND_IDS } from "./vault-secrets";

const field = (input: unknown, key: string): unknown =>
  typeof input === "object" && input !== null
    ? Reflect.get(input, key)
    : undefined;

/** A row id the vault makes: `prefix`, a dash, and 16 bytes in base64url. */
const parseId =
  (prefix: "sec" | "tok", what: string) =>
  (input: unknown): { readonly id: string } => {
    const id = field(input, "id");
    if (
      typeof id !== "string" ||
      !new RegExp(`^${prefix}-[A-Za-z0-9_-]{22}$`, "u").test(id)
    ) {
      throw new TypeError(`Invalid ${what} id.`);
    }
    return { id };
  };

/** A version the page showed: 0 for none, or a secret's version. */
const parseVersion = (input: unknown): number => {
  const version = field(input, "expectedVersion");
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 0
  ) {
    throw new TypeError(
      "A secret's expected version is 0 for a new one, or the version the page showed.",
    );
  }
  return version;
};

const parsePut = (
  input: unknown,
): {
  readonly name: string;
  readonly kind: VaultSecretKind;
  readonly value: unknown;
  readonly expectedVersion: number;
} => {
  const name = field(input, "name");
  const kind = field(input, "kind");
  const expectedVersion = parseVersion(input);
  if (typeof name !== "string") {
    throw new TypeError("A secret's name must be a string.");
  }
  if (!VAULT_SECRET_KIND_IDS.includes(kind as VaultSecretKind)) {
    throw new TypeError("Unknown secret kind.");
  }
  return {
    name,
    kind: kind as VaultSecretKind,
    value: field(input, "value"),
    expectedVersion,
  };
};

const parseIssue = (
  input: unknown,
): {
  readonly name: string;
  readonly scope: VaultTokenScope;
  readonly expiresAtMs?: number;
} => {
  const name = field(input, "name");
  const expiresAtMs = field(input, "expiresAtMs");
  if (typeof name !== "string") {
    throw new TypeError("A token's name must be a string.");
  }
  if (expiresAtMs !== undefined && typeof expiresAtMs !== "number") {
    throw new TypeError("A token's expiry must be a time in milliseconds.");
  }
  // The vault checks the scope itself, and names what it refuses.
  return {
    name,
    scope: field(input, "scope") as VaultTokenScope,
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  };
};

/** The vault, once the console's access check and the feature guard pass. */
const vaultApi = async () => {
  const [{ prepareConfig }, { requireFeature }] = await Promise.all([
    import("./server/config.server"),
    import("./server/runtime.server"),
  ]);
  const { runtime } = await prepareConfig();
  return requireFeature(runtime, "vault");
};

/** Whether the console holds the vault's master keys to store secrets with: one read. */
export const getVaultStatusRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .handler(async (): Promise<VaultStatus> => (await vaultApi()).status());

/** The master keys, with the stored versions under each. */
export const getVaultKeysRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .handler(async (): Promise<VaultMasterKeys> => (await vaultApi()).keys());

/**
 * Moves one batch of stored versions to the active master key; the page
 * calls it until none remain, showing the count as it falls.
 */
export const rewrapVaultRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .handler(async (): Promise<VaultRewrapResult> => (await vaultApi()).rewrap());

export const listVaultSecretsRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .handler(
    async (): Promise<VaultSecret[]> => [...(await (await vaultApi()).list())],
  );

/**
 * Stores a secret's value: a new secret with `expectedVersion` 0, or the
 * next version of the one the page showed at `expectedVersion`. The vault
 * checks it in the write's transaction, so adding never replaces a secret
 * someone else stored under the name, and an overwrite never replaces a
 * newer version or brings back a deleted secret. The value must be its
 * kind's shape, and the secret's metadata is what the value shows without
 * its secrets, so the console never sends a value back. The vault refuses
 * a master key that is not its own in the same transaction.
 */
export const putVaultSecretRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator(parsePut)
  .handler(async ({ data }): Promise<VaultSecret> => {
    const vault = await vaultApi();
    const { parseVaultSecretValue } =
      await import("@hot-updater/server/plugins");
    const { vaultSecretMetadataOf } = await import("./server/bundleSigningKey");
    const value = parseVaultSecretValue(data.kind, data.value);
    return vault.put({
      name: data.name,
      kind: data.kind,
      value,
      metadata: await vaultSecretMetadataOf(data.kind, value),
      expectedVersion: data.expectedVersion,
    });
  });

/** Deletes the secret at the version the page showed, so a rotation since is kept. */
export const removeVaultSecretRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator((input: unknown) => ({
    ...parseId("sec", "secret")(input),
    expectedVersion: parseVersion(input),
  }))
  .handler(async ({ data }): Promise<VaultSecret> => {
    const removed = await (await vaultApi()).remove(data);
    if (removed === null) throw new Error("The secret was already deleted.");
    return removed;
  });

export const listVaultTokensRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .handler(
    async (): Promise<VaultToken[]> => [
      ...(await (await vaultApi()).listTokens()),
    ],
  );

export const issueVaultTokenRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator(parseIssue)
  .handler(
    async ({
      data,
    }): Promise<{ readonly token: string; readonly metadata: VaultToken }> =>
      (await vaultApi()).issueToken(data),
  );

export const revokeVaultTokenRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator(parseId("tok", "vault token"))
  .handler(async ({ data }): Promise<VaultToken> => {
    const revoked = await (await vaultApi()).revokeToken({ id: data.id });
    if (revoked === null) throw new Error("Vault token not found.");
    return revoked;
  });
