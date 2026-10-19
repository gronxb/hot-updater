import { definePlugin } from "@hot-updater/plugin-core";

import { createVaultApi, type VaultOptions } from "./api";
import { markOfficial } from "./official";
import { vaultSchema } from "./schema";

export {
  VAULT_KEPT_VERSIONS,
  VAULT_MAX_VALUE_BYTES,
  VAULT_SECRET_KINDS,
  type VaultApi,
  VaultInputError,
  VaultNotFoundError,
  type VaultOptions,
  type VaultSecret,
  type VaultSecretKind,
} from "./api";
export {
  VAULT_MASTER_KEY_ENV,
  VaultIntegrityError,
  VaultLockedError,
} from "./crypto";
export { vaultSchema, type VaultSchema } from "./schema";

/**
 * Vault: signing and deploy credentials, stored in the database only as
 * AES-256-GCM ciphertext under data keys that the master key wraps. It adds
 * tables and `hotUpdater.api.vault`, and no routes: the Console serves the
 * vault and holds the master key, so a server or the CLI without it lists
 * secrets but cannot read them.
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
