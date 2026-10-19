import { defineTable } from "@hot-updater/plugin-core";

/**
 * The vault's tables, `vault_*` in the database. Values are stored only as
 * AES-256-GCM ciphertext under a data key that the master key wraps; the
 * master key itself never reaches the database.
 */
export const vaultSchema = {
  /** One row per secret name; a removed secret keeps its row as a tombstone. */
  secrets: defineTable(
    {
      id: { type: "string", maxLength: 64 },
      name: { type: "string", maxLength: 64, unique: true },
      kind: { type: "string", maxLength: 32 },
      /** The version `reveal` decrypts; versions only grow, so a version's AAD is never reused. */
      current_version: { type: "integer" },
      /** Non-secret details, such as a key id or an alias. */
      metadata: { type: "json" },
      created_at_ms: { type: "integer" },
      updated_at_ms: { type: "integer" },
      deleted_at_ms: { type: "integer", required: false },
    },
    {
      key: ["id"],
      // `list` reads every secret in name order; the unique `name` index
      // only answers lookups of one name.
      indexes: { byName: { eq: [], sort: ["name"] } },
    },
  ),
  /** A secret's last versions, each sealed under a data key of its own. */
  secret_versions: defineTable(
    {
      secret_id: { type: "string", maxLength: 64 },
      version: { type: "integer" },
      /** The master key that wrapped `wrapped_dek`. */
      kid: { type: "string", maxLength: 32 },
      /** base64url of the wrap's 12-byte IV, then the data key's ciphertext and tag. */
      wrapped_dek: { type: "string", maxLength: 128 },
      /** base64url of the value's 12-byte IV. */
      iv: { type: "string", maxLength: 32 },
      /** base64url of the value's ciphertext and tag. */
      ciphertext: { type: "string", maxLength: 100_000 },
      created_at_ms: { type: "integer" },
    },
    {
      key: ["secret_id", "version"],
      indexes: { byKid: { eq: ["kid"], sort: ["secret_id"] } },
    },
  ),
  /** CI tokens; only their SHA-256 digests are stored. */
  tokens: defineTable(
    {
      id: { type: "string", maxLength: 64 },
      hash: { type: "string", maxLength: 64, unique: true },
      name: { type: "string", maxLength: 64 },
      prefix: { type: "string", maxLength: 16 },
      /** The secrets (names or kinds) and actions the token may use. */
      scope: { type: "json" },
      expires_at_ms: { type: "integer", required: false },
      created_at_ms: { type: "integer" },
      revoked_at_ms: { type: "integer", required: false },
    },
    {
      key: ["id"],
      // Tokens are listed newest first, as API keys are.
      indexes: { byCreated: { eq: [], sort: ["created_at_ms"] } },
    },
  ),
  /** Reads, signatures, and changes, with who made them and how they ended. */
  audit: defineTable(
    {
      id: { type: "string", maxLength: 64 },
      at_ms: { type: "integer" },
      /** A token id or a Console user's email. */
      actor: { type: "string", maxLength: 255 },
      action: { type: "string", maxLength: 16 },
      secret_id: { type: "string", maxLength: 64, required: false },
      outcome: { type: "string", maxLength: 16 },
      context: { type: "json" },
    },
    {
      key: ["id"],
      // The log reads newest first, for the vault, one secret, or one actor.
      indexes: {
        byTime: { eq: [], sort: ["at_ms"] },
        bySecret: { eq: ["secret_id"], sort: ["at_ms"] },
        byActor: { eq: ["actor"], sort: ["at_ms"] },
      },
    },
  ),
} as const;

export type VaultSchema = typeof vaultSchema;
