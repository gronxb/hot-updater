import { definePlugin } from "@hot-updater/plugin-core";

import { createVaultApi, type VaultOptions } from "./api";
import { markOfficial } from "./official";
import { vaultSchema } from "./schema";

export {
  authorizeVaultToken,
  VAULT_AUDIT_ACTIONS,
  VAULT_KEPT_VERSIONS,
  VAULT_MAX_VALUE_BYTES,
  VAULT_SECRET_KINDS,
  VAULT_TOKEN_ACTIONS,
  type VaultApi,
  type VaultAuditAction,
  type VaultAuditEntry,
  VaultInputError,
  VaultNotFoundError,
  type VaultOptions,
  type VaultSecret,
  type VaultSecretKind,
  type VaultStatus,
  type VaultToken,
  type VaultTokenAction,
  type VaultTokenScope,
  type VaultTokenVerification,
} from "./api";
export {
  VAULT_MASTER_KEY_ENV,
  VaultIntegrityError,
  VaultLockedError,
} from "./crypto";
export { vaultSchema, type VaultSchema } from "./schema";
export {
  parseVaultSecretValue,
  type VaultSecretValue,
  type VaultSecretValues,
  vaultSecretMetadata,
} from "./values";

/**
 * Vault: signing and deploy credentials, stored in the database only as
 * AES-256-GCM ciphertext under data keys that the master key wraps, and the
 * scoped tokens CI reaches them with. It adds tables and
 * `hotUpdater.api.vault`, and no routes: the Console serves the vault at
 * `/_hot-updater/vault/v1/` and holds the master key, so a server without it
 * lists secrets and manages tokens but cannot read secrets, and the CLI
 * never reveals one.
 */
export const vault = (options: VaultOptions = {}) => {
  const plugin = definePlugin({
    id: "vault",
    schemaVersion: "1.0.0",
    schema: vaultSchema,
    init: ({ db, now }) => ({ api: createVaultApi({ db, now, options }) }),
  });
  // Only this factory may take the id; tooling and the console tell it by the mark.
  return markOfficial(plugin);
};
