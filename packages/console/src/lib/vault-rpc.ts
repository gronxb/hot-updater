import type {
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

const parsePut = (
  input: unknown,
): {
  readonly name: string;
  readonly kind: VaultSecretKind;
  readonly value: unknown;
  readonly overwrite: boolean;
} => {
  const name = field(input, "name");
  const kind = field(input, "kind");
  const overwrite = field(input, "overwrite");
  if (typeof name !== "string") {
    throw new TypeError("A secret's name must be a string.");
  }
  if (!VAULT_SECRET_KIND_IDS.includes(kind as VaultSecretKind)) {
    throw new TypeError("Unknown secret kind.");
  }
  if (typeof overwrite !== "boolean") {
    throw new TypeError("Say whether the secret is new or overwritten.");
  }
  return {
    name,
    kind: kind as VaultSecretKind,
    value: field(input, "value"),
    overwrite,
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

/** Whether the console holds a master key to store secrets with; reads nothing. */
export const getVaultStatusRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .handler(async (): Promise<VaultStatus> => (await vaultApi()).status());

export const listVaultSecretsRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .handler(
    async (): Promise<VaultSecret[]> => [...(await (await vaultApi()).list())],
  );

/**
 * Stores a secret's value: a new secret, or with `overwrite`, the next
 * version of one. The vault's `put` does either, so the name is checked
 * first: adding never replaces a secret someone else stored under the name,
 * and an overwrite never brings back one someone deleted. The value must be
 * its kind's shape, and the secret's metadata is what the value shows
 * without its secrets, so the console never sends a value back.
 */
export const putVaultSecretRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator(parsePut)
  .handler(async ({ data }): Promise<VaultSecret> => {
    const vault = await vaultApi();
    const { parseVaultSecretValue, vaultSecretMetadata } =
      await import("@hot-updater/server/plugins");
    const value = parseVaultSecretValue(data.kind, data.value);
    const exists = (await vault.list()).some(({ name }) => name === data.name);
    if (exists !== data.overwrite) {
      throw new Error(
        exists
          ? `A secret is already named ${data.name}. Overwrite it from its row instead.`
          : `No secret is named ${data.name} anymore. Add it again.`,
      );
    }
    return vault.put({
      name: data.name,
      kind: data.kind,
      value,
      metadata: vaultSecretMetadata(data.kind, value),
    });
  });

export const removeVaultSecretRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator(parseId("sec", "secret"))
  .handler(async ({ data }): Promise<VaultSecret> => {
    const removed = await (await vaultApi()).remove({ id: data.id });
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
