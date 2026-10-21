import {
  DatabaseConstraintError,
  type DatabaseJson,
  type HotUpdaterDatabase,
} from "@hot-updater/plugin-core";

import {
  DEFAULT_KID,
  importKeyring,
  open,
  rewrapDataKey,
  seal,
  VAULT_MASTER_KEY_ENV,
  VAULT_MASTER_KEYS_ENV,
  VaultIntegrityError,
  type VaultKeyring,
  VaultLockedError,
  type VaultMasterKey,
} from "./crypto";
import type { VaultSchema } from "./schema";
import {
  generateVaultToken,
  hashVaultToken,
  isVaultToken,
  randomId,
  VAULT_TOKEN_PREFIX,
} from "./token";

/** What a secret holds, which decides who reads it and how. */
export const VAULT_SECRET_KINDS = [
  "asc-api-key",
  "android-keystore",
  "play-service-account",
  "bundle-signing-key",
  "deploy-credentials",
  "generic",
] as const;

export type VaultSecretKind = (typeof VAULT_SECRET_KINDS)[number];

/** A value's limit, as UTF-8 JSON: enough for a keystore in base64. */
export const VAULT_MAX_VALUE_BYTES = 64 * 1024;
/** Versions kept per secret; writing a newer one deletes the oldest. */
export const VAULT_KEPT_VERSIONS = 5;

/**
 * What a token may do with the secrets in its scope: `read` their values,
 * `sign` with them, which the Console's remote signing serves, or `write`
 * new values, which the Console seals with its master key. `write` reads
 * nothing back: a token that may only write learns a secret's metadata,
 * never its value.
 */
export const VAULT_TOKEN_ACTIONS = ["read", "sign", "write"] as const;

export type VaultTokenAction = (typeof VAULT_TOKEN_ACTIONS)[number];

/**
 * The secrets a token reaches and what it may do with them. A secret is in
 * scope when `names` lists its name or `kinds` its kind; a scope names at
 * least one, and listing every kind is how a token reaches every secret.
 */
export interface VaultTokenScope {
  readonly secrets: {
    readonly names?: readonly string[];
    readonly kinds?: readonly VaultSecretKind[];
  };
  readonly actions: readonly VaultTokenAction[];
}

/** A vault token without its digest; the plaintext is never stored. */
export interface VaultToken {
  readonly id: string;
  readonly name: string;
  /** The token's first characters, to tell tokens apart. */
  readonly prefix: string;
  readonly scope: VaultTokenScope;
  /** When the token stops working; null when it never expires. */
  readonly expiresAtMs: number | null;
  readonly createdAtMs: number;
  readonly revokedAtMs: number | null;
}

/**
 * What an audit entry records: a list of secrets, a read of their values, a
 * write of a new value, or a signature made with a bundle signing key.
 */
export const VAULT_AUDIT_ACTIONS = ["list", "read", "write", "sign"] as const;

export type VaultAuditAction = (typeof VAULT_AUDIT_ACTIONS)[number];

/** One line of the vault's audit log, as `recordAudit` takes it. */
export interface VaultAuditEntry {
  /** A token id or a Console user's email. */
  readonly actor: string;
  readonly action: VaultAuditAction;
  /** The secret the entry is about; absent for a list. */
  readonly secretId?: string;
  /** `denied` when the vault refused the request, such as out of scope. */
  readonly outcome: "allowed" | "denied";
  /** Non-secret details, such as the requested name or a CI run. */
  readonly context?: Readonly<Record<string, DatabaseJson>>;
}

/** What `verifyToken` found: the token, or why it is refused. */
export type VaultTokenVerification =
  | { readonly ok: true; readonly token: VaultToken }
  | {
      readonly ok: false;
      readonly reason: "unknown" | "revoked" | "expired";
    };

const MAX_METADATA_BYTES = 4 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PAGE_SIZE = 500;
/** Names or kinds a scope lists, which bounds its JSON. */
const MAX_SCOPE_ENTRIES = 100;
/** `hu_vault_` and the token's first four characters. */
const TOKEN_PREFIX_LENGTH = VAULT_TOKEN_PREFIX.length + 4;

/** A secret without its value. */
export interface VaultSecret {
  readonly id: string;
  readonly name: string;
  readonly kind: VaultSecretKind;
  /** The current version, 1 for a new secret. */
  readonly version: number;
  readonly metadata: Readonly<Record<string, DatabaseJson>>;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** Whether the vault can seal and open values, and why not. */
export type VaultStatus =
  | { readonly locked: false }
  | {
      readonly locked: true;
      readonly message: string;
      /**
       * The master keys the vault was sealed under, by kid: only they open
       * it. None while it has sealed nothing, when any new key would do.
       */
      readonly knownKeys: readonly string[];
    };

/** One master key: the vault's, the Console's, or both. */
export interface VaultMasterKeyStatus {
  readonly kid: string;
  /** The key new values are sealed with: the Console's first. */
  readonly active: boolean;
  /** Whether the Console holds the key, so it opens what is sealed under it. */
  readonly held: boolean;
  /**
   * Whether the vault knows the key: it keeps a check for it, so only this
   * key is accepted under its kid. `rewrap` forgets an older key once no
   * version is left under it, even when none ever was.
   */
  readonly known: boolean;
  /** Stored versions whose data keys this key wraps. */
  readonly versions: number;
}

/** The master keys, and how far a rotation to the active one has come. */
export interface VaultMasterKeys {
  /** The Console's keys in order, then the others the vault knows. */
  readonly keys: readonly VaultMasterKeyStatus[];
  /** Versions under a key other than the active one, which `rewrap` moves. */
  readonly remaining: number;
}

/** The versions rewrapped in this batch, and those still under another key. */
export interface VaultRewrapResult {
  readonly rewrapped: number;
  readonly remaining: number;
}

/** The versions `rewrap` moves at most per call, unless given. */
export const VAULT_REWRAP_BATCH = 100;
const MAX_REWRAP_BATCH = 1000;

/** `hotUpdater.api.vault`. */
export interface VaultApi {
  /**
   * Whether the master keys are set, well formed, and the vault's, so `put`
   * can run: each key the vault knows opens the check value the vault keeps
   * for it, and unless the vault is new, the Console holds at least one of
   * them. One read. The Console asks before it offers to store a secret,
   * and `put` checks the same in its transaction.
   */
  status(): Promise<VaultStatus>;
  /**
   * The master keys the Console holds and the vault knows, with the stored
   * versions under each, counted page by page through the `byKid` index.
   * It opens nothing.
   */
  keys(): Promise<VaultMasterKeys>;
  /**
   * Moves up to `batch` stored versions (100 by default) to the active
   * master key: each data key is unwrapped with its own key and wrapped
   * again with the active one, and the value's ciphertext stays as it is.
   * Once no version is left under a key, the vault forgets that key, so a
   * Console that holds only it is locked. Call it until `remaining` is 0;
   * versions under a key the Console does not hold stay where they are.
   * Throws `VaultLockedError` as `put` does.
   */
  rewrap(input?: { readonly batch?: number }): Promise<VaultRewrapResult>;
  /** Every secret but removed ones, by name, without values. */
  list(): Promise<readonly VaultSecret[]>;
  /**
   * Stores `value` as the next version of the secret `name`, creating it,
   * or bringing back a removed one, as needed. `metadata` replaces the
   * secret's when given. Throws `VaultLockedError` without a master key, or
   * with one the vault would not open with (see `status`), and
   * `VaultConflictError` when `expectedVersion` no longer holds.
   */
  put(input: {
    readonly name: string;
    readonly kind: VaultSecretKind;
    readonly value: unknown;
    readonly metadata?: Readonly<Record<string, unknown>>;
    /**
     * The version the caller saw, checked in the write's transaction: 0 for
     * a name no secret has, so adding never replaces one, or a secret's
     * current version, so an overwrite never replaces a newer one or brings
     * back a removed one.
     */
    readonly expectedVersion?: number;
    /**
     * Who writes, recorded as an allowed `write` of the secret in the audit
     * log in the write's own transaction, so the log holds an entry exactly
     * when the version is stored.
     */
    readonly audit?: Pick<VaultAuditEntry, "actor" | "context">;
  }): Promise<VaultSecret>;
  /**
   * Removes a secret and deletes its values; null when there is none.
   * Throws `VaultConflictError` when it is no longer at `expectedVersion`,
   * the version the caller saw, so a rotation since then is not deleted.
   */
  remove(input: {
    readonly id: string;
    readonly expectedVersion?: number;
  }): Promise<VaultSecret | null>;
  /**
   * The current value of a secret. Throws `VaultNotFoundError` when there is
   * no such secret, or it is no longer at `version`, `VaultLockedError`
   * without the master key that sealed it, and `VaultIntegrityError` when its
   * stored value does not decrypt.
   */
  reveal(input: {
    readonly id: string;
    /** Who reads the value, a token id or a Console user's email. */
    readonly actor: string;
    /**
     * The version to open, such as the one `list` returned and a caller
     * authorized: a secret's kind changes only with a new version, so a
     * rotation, or a removal and a new secret under its id, since then is
     * refused instead of opened.
     */
    readonly version?: number;
  }): Promise<unknown>;
  /**
   * Issues a token for CI and returns its plaintext once; the vault keeps
   * only its SHA-256 digest. Without `expiresAtMs` it never expires.
   */
  issueToken(input: {
    readonly name: string;
    readonly scope: VaultTokenScope;
    readonly expiresAtMs?: number;
  }): Promise<{ readonly token: string; readonly metadata: VaultToken }>;
  /** Every token, revoked and expired ones too, newest first. */
  listTokens(): Promise<readonly VaultToken[]>;
  /** Revokes a token at once; null when there is none. */
  revokeToken(input: { readonly id: string }): Promise<VaultToken | null>;
  /**
   * Looks a token up by its digest, one read on every call, so a revocation
   * holds from the next request. Pass the token it returns to
   * `authorizeVaultToken` for each secret and action.
   */
  verifyToken(input: {
    readonly token: string;
  }): Promise<VaultTokenVerification>;
  /**
   * Appends entries to the audit log in one write, reading nothing, so the
   * Console records each request it serves before it answers.
   */
  recordAudit(input: {
    readonly entries: readonly VaultAuditEntry[];
  }): Promise<void>;
}

/** An argument the vault refuses, such as an unknown kind. */
export class VaultInputError extends TypeError {
  override readonly name = "VaultInputError";
}

/** A secret is no longer at the version a write expected. */
export class VaultConflictError extends Error {
  override readonly name = "VaultConflictError";
}

/** No secret has the id, or it was removed. */
export class VaultNotFoundError extends Error {
  override readonly name = "VaultNotFoundError";
}

export interface VaultOptions {
  /**
   * The master key, 32 bytes in base64, whose kid is `default`. Without
   * `masterKey` or `masterKeys`, the vault reads the
   * `HOT_UPDATER_VAULT_MASTER_KEY` and `HOT_UPDATER_VAULT_MASTER_KEYS`
   * environment variables when it seals or opens a value. Without a key,
   * `list` and `remove` work, and `put` and `reveal` throw
   * `VaultLockedError`.
   */
  readonly masterKey?: string;
  /**
   * Master keys while they rotate, as `kid:key` pairs separated by commas,
   * such as `"2026-10:<new key>,default:<old key>"`: the first seals new
   * values, and every one opens what was sealed under it. With `masterKey`
   * too, that key follows them as `default`.
   */
  readonly masterKeys?: string;
}

const readEnv = (name: string): string | undefined =>
  (
    globalThis as {
      readonly process?: { readonly env?: Record<string, string | undefined> };
    }
  ).process?.env?.[name];

/**
 * Resolves the master keys on each use, so a vault without one still lists:
 * the options' when either is given, otherwise the environment's.
 */
const keyringResolver = (options: VaultOptions) => {
  let cached:
    | { readonly encoded: string; readonly keyring: Promise<VaultKeyring> }
    | undefined;
  return (): Promise<VaultKeyring> => {
    const fromOptions =
      options.masterKey !== undefined || options.masterKeys !== undefined;
    const input = fromOptions
      ? {
          keys: options.masterKeys,
          key: options.masterKey,
          names: {
            keys: "vault({ masterKeys })",
            key: "vault({ masterKey })",
          },
        }
      : {
          keys: readEnv(VAULT_MASTER_KEYS_ENV),
          key: readEnv(VAULT_MASTER_KEY_ENV),
        };
    const encoded = JSON.stringify([fromOptions, input.keys, input.key]);
    if (cached?.encoded !== encoded) {
      cached = {
        encoded,
        keyring: importKeyring(input).then((keyring) => {
          if (keyring !== null) return keyring;
          throw new NoMasterKeyError(
            `The vault is locked: set ${VAULT_MASTER_KEY_ENV}, or ${VAULT_MASTER_KEYS_ENV} for named keys, where the Console runs to seal and reveal secrets.`,
          );
        }),
      };
    }
    return cached.keyring;
  };
};

/**
 * The Console holds no master key at all. Where the vault knows its keys,
 * the error names them instead, as `notHeld` does: after a rotation the
 * single-key variable is not where the vault's key goes.
 */
class NoMasterKeyError extends VaultLockedError {}

/**
 * The row of `secrets` that holds a check value per master key the vault
 * knows: a constant sealed under that key. Its id and name are outside the
 * names a secret takes, so no secret lists, reveals, or replaces it, and
 * it is read by its id, one read.
 */
const KEYS_ROW_ID = ".master-keys";
const KEY_CHECK = "hot-updater-vault/key-check";

type KeyCheck = {
  readonly wrapped_dek: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly created_at_ms: number;
};
type KeyChecks = Readonly<Record<string, KeyCheck>>;

const keyChecksOf = (row: { readonly metadata: DatabaseJson } | null) => {
  const checks =
    row !== null && isPlainObject(row.metadata)
      ? row.metadata.checks
      : undefined;
  return (isPlainObject(checks) ? checks : {}) as KeyChecks;
};

/** Each kid's check binds its kid, so it does not open as another kid's. */
const keyCheckId = (kid: string) => `${KEYS_ROW_ID}/${kid}`;

const sealKeyCheck = async (
  key: VaultMasterKey,
  at: number,
): Promise<KeyCheck> => {
  const { wrapped_dek, iv, ciphertext } = await seal({
    masterKey: key,
    secretId: keyCheckId(key.kid),
    version: 0,
    plaintext: new TextEncoder().encode(KEY_CHECK),
  });
  return { wrapped_dek, iv, ciphertext, created_at_ms: at };
};

const opensKeyCheck = async (key: VaultMasterKey, check: KeyCheck) => {
  try {
    const plaintext = await open({
      masterKey: key,
      secretId: keyCheckId(key.kid),
      version: 0,
      sealed: { kid: key.kid, ...check },
    });
    return new TextDecoder().decode(plaintext) === KEY_CHECK;
  } catch (error) {
    if (error instanceof VaultIntegrityError) return false;
    throw error;
  }
};

const quoteKids = (kids: readonly string[]) =>
  kids.map((kid) => `"${kid}"`).join(", ");

/**
 * Throws `VaultLockedError` unless the Console's keys are the vault's: each
 * one the vault knows opens its check, and unless the vault knows none yet,
 * the Console holds one of them. So Consoles with different keys never
 * seal into one vault, even an empty one.
 */
const checkKeyring = (keyring: VaultKeyring, checks: KeyChecks) =>
  checkKeys(keyring, Object.keys(checks), (key) =>
    opensKeyCheck(key, checks[key.kid]!),
  );

/**
 * `checkKeyring` for a vault without a keys row, against a stored version
 * under each kid instead of its check: the key must unwrap its data key.
 */
const checkSealed = async (
  keyring: VaultKeyring,
  sealed: Readonly<Record<string, SealedRow>>,
) => {
  // The checks it starts are the Console's keys only, so it needs them all:
  // a version under a key it lacks would stay out of `keys` and `rewrap`.
  const lacking = Object.keys(sealed).filter(
    (kid) => !keyring.keys.some((key) => key.kid === kid),
  );
  if (lacking.length > 0) throw notHeld(lacking);
  await checkKeys(keyring, Object.keys(sealed), (key) =>
    unwraps(key, sealed[key.kid]!),
  );
};

/** A stored version, as much of it as unwrapping its data key reads. */
type SealedRow = {
  readonly secret_id: string;
  readonly version: number;
  readonly wrapped_dek: string;
};

const unwraps = async (key: VaultMasterKey, row: SealedRow) => {
  try {
    await rewrapDataKey({
      from: key,
      to: key,
      secretId: row.secret_id,
      version: row.version,
      wrappedDek: row.wrapped_dek,
    });
    return true;
  } catch (error) {
    if (error instanceof VaultIntegrityError) return false;
    throw error;
  }
};

const checkKeys = async (
  keyring: VaultKeyring,
  known: readonly string[],
  opens: (key: VaultMasterKey) => Promise<boolean>,
) => {
  let held = false;
  for (const key of keyring.keys) {
    if (!known.includes(key.kid)) continue;
    if (!(await opens(key))) {
      throw new VaultLockedError(
        `The vault is locked: the master key "${key.kid}" in ${VAULT_MASTER_KEY_ENV} or ${VAULT_MASTER_KEYS_ENV} is not the key the vault's secrets were saved with as "${key.kid}". Restore that key where the Console runs.`,
      );
    }
    held = true;
  }
  if (!held && known.length > 0) throw notHeld(known);
};

const notHeld = (kids: readonly string[]) => {
  // Only the key `default` can come from the single-key variable.
  const where =
    kids.length === 1 && kids[0] === DEFAULT_KID
      ? `Set it in ${VAULT_MASTER_KEY_ENV}, or after the new key in ${VAULT_MASTER_KEYS_ENV} to rotate to the new one.`
      : `List it in ${VAULT_MASTER_KEYS_ENV} as ${kids.map((kid) => `"${kid}:<key>"`).join(" or ")}, after the new key to rotate to the new one.`;
  return new VaultLockedError(
    `The vault is locked: its secrets are saved under the master key ${quoteKids(kids)}, which the Console does not hold. ${where}`,
  );
};

/** A write found no keys row: it reruns once the stored versions are checked. */
class KeysRowMissing extends Error {}

const normalizeName = (name: unknown): string => {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new VaultInputError(
      "A secret name is 1-64 letters, digits, dots, dashes, or underscores, starting with a letter or digit.",
    );
  }
  return name;
};

const normalizeKind = (kind: unknown): VaultSecretKind => {
  if (!VAULT_SECRET_KINDS.includes(kind as VaultSecretKind)) {
    throw new VaultInputError(
      `A secret kind is one of ${VAULT_SECRET_KINDS.join(", ")}.`,
    );
  }
  return kind as VaultSecretKind;
};

const utf8Length = (text: string) => new TextEncoder().encode(text).byteLength;

const encodeValue = (value: unknown): Uint8Array<ArrayBuffer> => {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    throw new VaultInputError("A secret's value is a JSON value.");
  }
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > VAULT_MAX_VALUE_BYTES) {
    throw new VaultInputError(
      `A secret's value holds up to ${VAULT_MAX_VALUE_BYTES} bytes of JSON.`,
    );
  }
  return bytes;
};

const normalizeMetadata = (
  metadata: unknown,
): Readonly<Record<string, DatabaseJson>> => {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new VaultInputError("A secret's metadata is a JSON object.");
  }
  let json: string;
  try {
    json = JSON.stringify(metadata);
  } catch {
    throw new VaultInputError("A secret's metadata is a JSON object.");
  }
  if (utf8Length(json) > MAX_METADATA_BYTES) {
    throw new VaultInputError(
      `A secret's metadata holds up to ${MAX_METADATA_BYTES} bytes of JSON.`,
    );
  }
  return JSON.parse(json) as Record<string, DatabaseJson>;
};

type SecretRow = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly current_version: number;
  readonly metadata: DatabaseJson;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
};

const normalizeTokenName = (name: unknown): string => {
  const normalized = typeof name === "string" ? name.trim() : "";
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    throw new VaultInputError("A token name is 1-64 visible characters.");
  }
  return normalized;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeAuditContext = (
  context: unknown,
): Readonly<Record<string, DatabaseJson>> => {
  if (!isPlainObject(context)) {
    throw new VaultInputError("An audit entry's context is a JSON object.");
  }
  const json = JSON.stringify(context);
  if (utf8Length(json) > MAX_METADATA_BYTES) {
    throw new VaultInputError(
      `An audit entry's context holds up to ${MAX_METADATA_BYTES} bytes of JSON.`,
    );
  }
  return JSON.parse(json) as Record<string, DatabaseJson>;
};

const refuseUnknownKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new VaultInputError(
      `A token's ${what} has only ${allowed.join(" and ")}, not ${unknown.join(", ")}.`,
    );
  }
};

/** A deduplicated list, or undefined when `value` is undefined. */
const normalizeList = <T extends string>(
  value: unknown,
  what: string,
  normalize: (entry: unknown) => T,
): T[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new VaultInputError(`A token's ${what} is a list.`);
  }
  const entries = [...new Set(value.map(normalize))];
  if (entries.length > MAX_SCOPE_ENTRIES) {
    throw new VaultInputError(
      `A token's ${what} lists up to ${MAX_SCOPE_ENTRIES} entries.`,
    );
  }
  return entries;
};

const normalizeAction = (action: unknown): VaultTokenAction => {
  if (!VAULT_TOKEN_ACTIONS.includes(action as VaultTokenAction)) {
    throw new VaultInputError(
      `A token's action is one of ${VAULT_TOKEN_ACTIONS.join(", ")}.`,
    );
  }
  return action as VaultTokenAction;
};

const normalizeScope = (scope: unknown): VaultTokenScope => {
  if (!isPlainObject(scope)) {
    throw new VaultInputError("A token's scope is an object.");
  }
  refuseUnknownKeys(scope, ["secrets", "actions"], "scope");
  if (!isPlainObject(scope.secrets)) {
    throw new VaultInputError(
      "A token's scope names its secrets, by names or kinds.",
    );
  }
  refuseUnknownKeys(scope.secrets, ["names", "kinds"], "secrets");
  const names = normalizeList(scope.secrets.names, "names", normalizeName);
  const kinds = normalizeList(scope.secrets.kinds, "kinds", normalizeKind);
  // No implicit "every secret": an empty scope reaches none, so it is refused.
  if ((names?.length ?? 0) === 0 && (kinds?.length ?? 0) === 0) {
    throw new VaultInputError(
      "A token's scope names at least one secret or kind.",
    );
  }
  const actions = normalizeList(scope.actions, "actions", normalizeAction);
  if (actions === undefined || actions.length === 0) {
    throw new VaultInputError(
      `A token's scope allows at least one action of ${VAULT_TOKEN_ACTIONS.join(", ")}.`,
    );
  }
  return {
    secrets: {
      ...(names === undefined ? {} : { names }),
      ...(kinds === undefined ? {} : { kinds }),
    },
    actions,
  };
};

const EMPTY_SCOPE: VaultTokenScope = Object.freeze({
  secrets: Object.freeze({
    names: Object.freeze([]),
    kinds: Object.freeze([]),
  }),
  actions: Object.freeze([]),
});

/**
 * A stored scope as read back, checked as `issueToken` checks one: a scope
 * with any malformed part, such as one unknown action, reaches nothing.
 */
const readScope = (value: DatabaseJson): VaultTokenScope => {
  let scope: VaultTokenScope;
  try {
    scope = normalizeScope(value);
  } catch (error) {
    if (error instanceof VaultInputError) return EMPTY_SCOPE;
    throw error;
  }
  return Object.freeze({
    secrets: Object.freeze({
      names: Object.freeze([...(scope.secrets.names ?? [])]),
      kinds: Object.freeze([...(scope.secrets.kinds ?? [])]),
    }),
    actions: Object.freeze([...scope.actions]),
  });
};

type TokenRow = {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scope: DatabaseJson;
  readonly expires_at_ms: number | null;
  readonly created_at_ms: number;
  readonly revoked_at_ms: number | null;
};

const toToken = (row: TokenRow): VaultToken =>
  Object.freeze({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: readScope(row.scope),
    expiresAtMs: row.expires_at_ms,
    createdAtMs: row.created_at_ms,
    revokedAtMs: row.revoked_at_ms,
  });

/**
 * Whether a token may take `action` on `secret`: the action is in its scope,
 * and so is the secret, by name or by kind. `sign` is checked against the
 * signing key's secret like `read`, and `write` against the secret a write
 * stores, by its new name and kind. It checks only the scope; pass a token
 * `verifyToken` just returned, which has checked revocation and expiry.
 */
export const authorizeVaultToken = (
  token: Pick<VaultToken, "scope" | "revokedAtMs">,
  request: {
    readonly action: VaultTokenAction;
    readonly secret: { readonly name: string; readonly kind: string };
  },
): boolean => {
  const { secrets, actions } = token.scope;
  return (
    token.revokedAtMs === null &&
    actions.includes(request.action) &&
    ((secrets.names?.includes(request.secret.name) ?? false) ||
      (secrets.kinds?.includes(request.secret.kind as VaultSecretKind) ??
        false))
  );
};

/** The keys row read where a secret is: no secret has its id. */
const isSecretRow = <T extends { readonly id: string }>(
  row: T | null,
): row is T => row !== null && row.id !== KEYS_ROW_ID;

const toSecret = (row: SecretRow): VaultSecret =>
  Object.freeze({
    id: row.id,
    name: row.name,
    kind: row.kind as VaultSecretKind,
    version: row.current_version,
    metadata: (row.metadata ?? {}) as Record<string, DatabaseJson>,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  });

type AuditRow = {
  readonly id: string;
  readonly actor: string;
  readonly action: VaultAuditAction;
  readonly secret_id: string | null;
  readonly outcome: VaultAuditEntry["outcome"];
  readonly context: Readonly<Record<string, DatabaseJson>>;
};

/** An audit entry as its row, without its time, or a thrown `VaultInputError`. */
const toAuditRow = (entry: VaultAuditEntry): AuditRow => {
  if (
    !VAULT_AUDIT_ACTIONS.includes(entry.action) ||
    (entry.outcome !== "allowed" && entry.outcome !== "denied") ||
    typeof entry.actor !== "string" ||
    entry.actor.length === 0 ||
    entry.actor.length > 255
  ) {
    throw new VaultInputError(
      `An audit entry has an actor of 1-255 characters, an action of ${VAULT_AUDIT_ACTIONS.join(", ")}, and an outcome of allowed or denied.`,
    );
  }
  return {
    id: randomId("aud"),
    actor: entry.actor,
    action: entry.action,
    secret_id: entry.secretId ?? null,
    outcome: entry.outcome,
    context:
      entry.context === undefined ? {} : normalizeAuditContext(entry.context),
  };
};

/** The vault's API over its tables. */
export const createVaultApi = ({
  db,
  now,
  options = {},
}: {
  readonly db: HotUpdaterDatabase<VaultSchema>;
  readonly now: () => number;
  readonly options?: VaultOptions;
}): VaultApi => {
  const resolveKeyring = keyringResolver(options);
  /**
   * The Console's keys; without any, a locked error naming the keys the
   * vault's keys row knows, read only then.
   */
  const keyringOf = async () => {
    try {
      return await resolveKeyring();
    } catch (error) {
      if (!(error instanceof NoMasterKeyError)) throw error;
      const known = Object.keys(
        keyChecksOf(await db.findOne("secrets", { id: KEYS_ROW_ID })),
      );
      throw known.length > 0 ? notHeld(known) : error;
    }
  };

  /** The stored versions under one master key, a page at a time. */
  const countVersions = async (kid: string) => {
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await db.findMany("secret_versions", {
        index: "byKid",
        where: { kid },
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      count += page.rows.length;
      cursor = page.next;
    } while (cursor !== undefined);
    return count;
  };

  /**
   * A stored version under each kid the vault's kept versions use, for a
   * vault without a keys row: one sealed before vaults kept key checks, or
   * whose row was deleted. Such versions are its keys' only evidence, so it
   * reads every page of secrets and their kept versions, one batch a page;
   * once the row exists, nothing reads this.
   */
  const findSealed = async () => {
    const sealed: Record<string, SealedRow> = {};
    let cursor: string | undefined;
    do {
      const page = await db.findMany("secrets", {
        index: "byName",
        where: {},
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const kept: { secret_id: string; version: number }[] = [];
      for (const row of page.rows) {
        // Removed secrets keep no versions.
        if (!isSecretRow(row) || row.deleted_at_ms !== null) continue;
        const first = Math.max(
          1,
          row.current_version - VAULT_KEPT_VERSIONS + 1,
        );
        for (let version = first; version <= row.current_version; version++) {
          kept.push({ secret_id: row.id, version });
        }
      }
      if (kept.length > 0) {
        for (const row of await db.findByKeys("secret_versions", kept)) {
          if (row !== null && !Object.hasOwn(sealed, row.kid)) {
            sealed[row.kid] = row;
          }
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return sealed;
  };

  /**
   * The keys a vault without a keys row records first: those that unwrap
   * its stored versions. Throws `VaultLockedError` as `status` reports.
   */
  const seedKeys = async (keyring: VaultKeyring) => {
    const sealed = await findSealed();
    await checkSealed(keyring, sealed);
    return keyring.keys.filter(({ kid }) => Object.hasOwn(sealed, kid));
  };

  /** The checks a new keys row starts with: the seeds' and the active key's. */
  const sealChecks = async (
    checks: KeyChecks,
    keys: readonly VaultMasterKey[],
    at: number,
  ): Promise<KeyChecks> => {
    const next: Record<string, KeyCheck> = { ...checks };
    for (const key of keys) {
      // Own properties only: a kid such as "constructor" is inherited.
      if (!Object.hasOwn(next, key.kid)) {
        next[key.kid] = await sealKeyCheck(key, at);
      }
    }
    return next;
  };

  const write = (input: {
    readonly name: string;
    readonly kind: VaultSecretKind;
    readonly plaintext: Uint8Array<ArrayBuffer>;
    readonly metadata: Readonly<Record<string, DatabaseJson>> | undefined;
    readonly keyring: VaultKeyring;
    /** The keys a missing keys row starts with, once checked. */
    readonly seeds?: readonly VaultMasterKey[];
    readonly expectedVersion: number | undefined;
    readonly audit: AuditRow | undefined;
  }) =>
    db.transaction(async (tx) => {
      const at = now();
      const { active } = input.keyring;
      // Every write checks the keys and bumps the keys row, so a rewrap
      // that forgets a key it found empty notices a write under it since.
      const keysRow = await tx.findOne("secrets", { id: KEYS_ROW_ID });
      if (keysRow === null && input.seeds === undefined) {
        throw new KeysRowMissing();
      }
      const checks = keyChecksOf(keysRow);
      await checkKeyring(input.keyring, checks);
      const keysMetadata = {
        checks: await sealChecks(
          checks,
          keysRow === null ? [...(input.seeds ?? []), active] : [active],
          at,
        ),
      };
      if (keysRow === null) {
        tx.create("secrets", {
          id: KEYS_ROW_ID,
          name: KEYS_ROW_ID,
          kind: "master-keys",
          current_version: 1,
          metadata: keysMetadata,
          created_at_ms: at,
          updated_at_ms: at,
          deleted_at_ms: null,
        });
      } else {
        tx.update("secrets", keysRow, {
          current_version: keysRow.current_version + 1,
          metadata: keysMetadata,
          updated_at_ms: at,
        });
      }
      const existing = await tx.findOne("secrets", { name: input.name });
      const current =
        existing !== null && existing.deleted_at_ms === null
          ? existing.current_version
          : 0;
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== current
      ) {
        throw new VaultConflictError(
          input.expectedVersion === 0
            ? `A secret is already named "${input.name}".`
            : current === 0
              ? `No secret is named "${input.name}" anymore.`
              : `The secret "${input.name}" is at version ${current} now, not ${input.expectedVersion}.`,
        );
      }
      if (
        existing !== null &&
        existing.deleted_at_ms === null &&
        existing.kind !== input.kind
      ) {
        throw new VaultInputError(
          `The secret "${input.name}" is a ${existing.kind}; remove it before storing a ${input.kind} under its name.`,
        );
      }
      const id = existing?.id ?? randomId("sec");
      const version = (existing?.current_version ?? 0) + 1;
      if (input.audit !== undefined) {
        tx.create("audit", { ...input.audit, secret_id: id, at_ms: at });
      }
      tx.create("secret_versions", {
        secret_id: id,
        version,
        ...(await seal({
          masterKey: active,
          secretId: id,
          version,
          plaintext: input.plaintext,
        })),
        created_at_ms: at,
      });
      if (existing === null) {
        const row = {
          id,
          name: input.name,
          kind: input.kind,
          current_version: version,
          metadata: input.metadata ?? {},
          created_at_ms: at,
          updated_at_ms: at,
          deleted_at_ms: null,
        };
        tx.create("secrets", row);
        return toSecret(row);
      }
      const set = {
        kind: input.kind,
        current_version: version,
        metadata:
          input.metadata ??
          (existing.deleted_at_ms === null ? existing.metadata : {}),
        updated_at_ms: at,
        deleted_at_ms: null,
      };
      tx.update("secrets", existing, set);
      // Versions are consecutive, so the one leaving the kept window is
      // exactly this far back; a removed secret's versions are gone already.
      if (version > VAULT_KEPT_VERSIONS) {
        const oldest = await tx.findOne("secret_versions", {
          secret_id: id,
          version: version - VAULT_KEPT_VERSIONS,
        });
        if (oldest !== null) await tx.delete("secret_versions", oldest);
      }
      return toSecret({ ...existing, ...set });
    });

  return Object.freeze({
    async status() {
      let keyring: VaultKeyring | VaultLockedError;
      try {
        keyring = await resolveKeyring();
      } catch (error) {
        if (!(error instanceof VaultLockedError)) throw error;
        keyring = error;
      }
      const keysRow = await db.findOne("secrets", { id: KEYS_ROW_ID });
      const checks = keyChecksOf(keysRow);
      // Without a keys row, stored versions stand in for the checks.
      const sealed = keysRow === null ? await findSealed() : {};
      const known = Object.keys(keysRow === null ? sealed : checks);
      try {
        if (keyring instanceof NoMasterKeyError && known.length > 0) {
          throw notHeld(known);
        }
        if (keyring instanceof VaultLockedError) throw keyring;
        if (keysRow === null) await checkSealed(keyring, sealed);
        else await checkKeyring(keyring, checks);
        return { locked: false } as const;
      } catch (error) {
        if (!(error instanceof VaultLockedError)) throw error;
        return Object.freeze({
          locked: true,
          message: error.message,
          knownKeys: Object.freeze(known),
        } as const);
      }
    },

    async keys() {
      let keyring: VaultKeyring | undefined;
      try {
        keyring = await resolveKeyring();
      } catch (error) {
        if (!(error instanceof VaultLockedError)) throw error;
      }
      const keysRow = await db.findOne("secrets", { id: KEYS_ROW_ID });
      const known =
        keysRow === null
          ? Object.keys(await findSealed())
          : Object.keys(keyChecksOf(keysRow));
      const kids = [
        ...new Set([...(keyring?.keys.map(({ kid }) => kid) ?? []), ...known]),
      ];
      const counts = await Promise.all(kids.map(countVersions));
      const keys = kids.map((kid, index) => ({
        kid,
        active: keyring?.active.kid === kid,
        held: keyring?.keys.some((key) => key.kid === kid) ?? false,
        known: known.includes(kid),
        versions: counts[index] ?? 0,
      }));
      return Object.freeze({
        keys: Object.freeze(keys),
        remaining: keys
          .filter(({ active }) => !active)
          .reduce((sum, { versions }) => sum + versions, 0),
      });
    },

    async rewrap({ batch = VAULT_REWRAP_BATCH } = {}) {
      if (
        !Number.isSafeInteger(batch) ||
        batch < 1 ||
        batch > MAX_REWRAP_BATCH
      ) {
        throw new VaultInputError(
          `A rewrap's batch is 1-${MAX_REWRAP_BATCH} versions.`,
        );
      }
      const keyring = await keyringOf();
      const { active } = keyring;
      // The active key's check goes in first, so forgetting the others
      // leaves the vault one key it knows.
      // A vault without a keys row starts one from its stored versions.
      const seeds =
        (await db.findOne("secrets", { id: KEYS_ROW_ID })) === null
          ? await seedKeys(keyring)
          : undefined;
      const before = await db.transaction(async (tx) => {
        const row = await tx.findOne("secrets", { id: KEYS_ROW_ID });
        if (row === null) {
          if (seeds === undefined || seeds.length === 0) return null;
          const at = now();
          const created = {
            id: KEYS_ROW_ID,
            name: KEYS_ROW_ID,
            kind: "master-keys",
            current_version: 1,
            metadata: {
              checks: await sealChecks({}, [...seeds, active], at),
            },
            created_at_ms: at,
            updated_at_ms: at,
            deleted_at_ms: null,
          };
          tx.create("secrets", created);
          return created;
        }
        const checks = keyChecksOf(row);
        await checkKeyring(keyring, checks);
        if (Object.hasOwn(checks, active.kid)) return row;
        const at = now();
        const set = {
          current_version: row.current_version + 1,
          metadata: {
            checks: { ...checks, [active.kid]: await sealKeyCheck(active, at) },
          },
          updated_at_ms: at,
        };
        tx.update("secrets", row, set);
        return { ...row, ...set };
      });
      // Nothing was ever stored.
      if (before === null) return { rewrapped: 0, remaining: 0 };

      const others = Object.keys(keyChecksOf(before)).filter(
        (kid) => kid !== active.kid,
      );
      let rewrapped = 0;
      for (const kid of others) {
        const from = keyring.keys.find((key) => key.kid === kid);
        // Versions under a key the Console does not hold stay, and count.
        if (from === undefined) continue;
        let cursor: string | undefined;
        while (rewrapped < batch) {
          const page = await db.findMany("secret_versions", {
            index: "byKid",
            where: { kid },
            limit: Math.min(PAGE_SIZE, batch - rewrapped),
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const listed of page.rows) {
            const moved = await db.transaction(async (tx) => {
              const keysRow = await tx.findOne("secrets", { id: KEYS_ROW_ID });
              const row = await tx.findOne("secret_versions", {
                secret_id: listed.secret_id,
                version: listed.version,
              });
              // Removed, pruned, or rewrapped since the page was read.
              if (keysRow === null || row === null || row.kid !== kid) {
                return false;
              }
              // A move bumps the keys row as a write does, so a rewrap on
              // another Console that counted the active kid empty keeps it,
              // and the active key's check comes back if one forgot it.
              const at = now();
              tx.update("secrets", keysRow, {
                current_version: keysRow.current_version + 1,
                metadata: {
                  checks: await sealChecks(keyChecksOf(keysRow), [active], at),
                },
                updated_at_ms: at,
              });
              tx.update(
                "secret_versions",
                row,
                await rewrapDataKey({
                  from,
                  to: active,
                  secretId: row.secret_id,
                  version: row.version,
                  wrappedDek: row.wrapped_dek,
                }),
              );
              return true;
            });
            if (moved) rewrapped += 1;
          }
          cursor = page.next;
          if (cursor === undefined) break;
        }
      }

      const counts = await Promise.all(others.map(countVersions));
      const empty = others.filter((_, index) => counts[index] === 0);
      if (empty.length > 0) {
        await db.transaction(async (tx) => {
          const row = await tx.findOne("secrets", { id: KEYS_ROW_ID });
          // A put or another rewrap since this one began bumped the row
          // beyond this one's own moves: it may have sealed under a key
          // counted empty, so the next rewrap decides.
          if (
            row === null ||
            row.current_version !== before.current_version + rewrapped
          ) {
            return;
          }
          const checks = { ...keyChecksOf(row) };
          for (const kid of empty) delete checks[kid];
          tx.update("secrets", row, {
            current_version: row.current_version + 1,
            metadata: { checks },
            updated_at_ms: now(),
          });
        });
      }
      return {
        rewrapped,
        remaining: counts.reduce((sum, count) => sum + count, 0),
      };
    },

    async list() {
      const secrets: VaultSecret[] = [];
      let cursor: string | undefined;
      do {
        const page = await db.findMany("secrets", {
          index: "byName",
          where: {},
          limit: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const row of page.rows) {
          if (isSecretRow(row) && row.deleted_at_ms === null) {
            secrets.push(toSecret(row));
          }
        }
        cursor = page.next;
      } while (cursor !== undefined);
      return Object.freeze(secrets);
    },

    async put({ name, kind, value, metadata, expectedVersion, audit }) {
      if (
        expectedVersion !== undefined &&
        (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
      ) {
        throw new VaultInputError(
          "A put's expectedVersion is 0 or a secret's version.",
        );
      }
      let input: Parameters<typeof write>[0] = {
        expectedVersion,
        // The secret's id is set in the write, once it is known.
        audit:
          audit === undefined
            ? undefined
            : toAuditRow({ ...audit, action: "write", outcome: "allowed" }),
        name: normalizeName(name),
        kind: normalizeKind(kind),
        plaintext: encodeValue(value),
        metadata:
          metadata === undefined ? undefined : normalizeMetadata(metadata),
        keyring: await keyringOf(),
      };
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await write(input);
        } catch (error) {
          // No keys row yet: check the key against what is stored first.
          if (error instanceof KeysRowMissing) {
            input = { ...input, seeds: await seedKeys(input.keyring) };
            attempt -= 1;
            continue;
          }
          // Another put took the name, or the version, first: this one
          // becomes the next version.
          if (
            attempt < 3 &&
            error instanceof DatabaseConstraintError &&
            (error.reason === "unique" || error.reason === "exists")
          ) {
            continue;
          }
          throw error;
        }
      }
    },

    remove: ({ id, expectedVersion }) =>
      db.transaction(async (tx) => {
        const row = await tx.findOne("secrets", { id });
        if (!isSecretRow(row) || row.deleted_at_ms !== null) return null;
        if (
          expectedVersion !== undefined &&
          row.current_version !== expectedVersion
        ) {
          throw new VaultConflictError(
            `The secret "${row.name}" is at version ${row.current_version} now, not ${expectedVersion}.`,
          );
        }
        // Only the kept window holds versions; deleting them deletes the values.
        const first = Math.max(
          1,
          row.current_version - VAULT_KEPT_VERSIONS + 1,
        );
        for (let version = first; version <= row.current_version; version++) {
          const sealed = await tx.findOne("secret_versions", {
            secret_id: id,
            version,
          });
          if (sealed !== null) await tx.delete("secret_versions", sealed);
        }
        const at = now();
        tx.update("secrets", row, { deleted_at_ms: at, updated_at_ms: at });
        return toSecret({ ...row, updated_at_ms: at });
      }),

    async reveal({ id, version }) {
      const keyring = await keyringOf();
      const row = await db.findOne("secrets", { id });
      if (!isSecretRow(row) || row.deleted_at_ms !== null) {
        throw new VaultNotFoundError(`No secret has the id "${id}".`);
      }
      if (version !== undefined && row.current_version !== version) {
        throw new VaultNotFoundError(
          `The secret "${row.name}" is no longer at version ${version}.`,
        );
      }
      const sealed = await db.findOne("secret_versions", {
        secret_id: id,
        version: row.current_version,
      });
      // Removed between the two reads: its versions went with it.
      if (sealed === null && version !== undefined) {
        throw new VaultNotFoundError(`No secret has the id "${id}".`);
      }
      if (sealed === null) {
        throw new VaultIntegrityError(
          `The secret "${row.name}" has no version ${row.current_version}.`,
        );
      }
      const key = keyring.keys.find(({ kid }) => kid === sealed.kid);
      if (key === undefined) {
        throw new VaultLockedError(
          `The secret "${row.name}" is sealed under the master key "${sealed.kid}", which the Console does not hold. List it in ${VAULT_MASTER_KEYS_ENV} as "${sealed.kid}:<key>" after the active key, and rewrap the vault before removing it.`,
        );
      }
      const plaintext = await open({
        masterKey: key,
        secretId: id,
        version: row.current_version,
        sealed,
      });
      return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    },

    // Tokens need no master key: the vault stores their digests, so a locked
    // vault, such as the CLI's over the database, still issues and revokes.
    async issueToken({ name, scope, expiresAtMs }) {
      const at = now();
      if (
        expiresAtMs !== undefined &&
        (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= at)
      ) {
        throw new VaultInputError(
          "A token's expiresAtMs is a time in milliseconds after now.",
        );
      }
      const token = generateVaultToken();
      const row = {
        id: randomId("tok"),
        hash: await hashVaultToken(token),
        name: normalizeTokenName(name),
        prefix: token.slice(0, TOKEN_PREFIX_LENGTH),
        scope: normalizeScope(scope) as unknown as DatabaseJson,
        expires_at_ms: expiresAtMs ?? null,
        created_at_ms: at,
        revoked_at_ms: null,
      };
      await db.transaction(async (tx) => {
        tx.create("tokens", row);
      });
      return Object.freeze({ token, metadata: toToken(row) });
    },

    async listTokens() {
      const tokens: VaultToken[] = [];
      let cursor: string | undefined;
      do {
        const page = await db.findMany("tokens", {
          index: "byCreated",
          where: {},
          order: "desc",
          limit: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        tokens.push(...page.rows.map(toToken));
        cursor = page.next;
      } while (cursor !== undefined);
      return Object.freeze(
        tokens.sort(
          (left, right) =>
            right.createdAtMs - left.createdAtMs ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        ),
      );
    },

    revokeToken: ({ id }) =>
      db.transaction(async (tx) => {
        const row = await tx.findOne("tokens", { id });
        if (row === null) return null;
        // A revoked token keeps the time it was first revoked.
        if (row.revoked_at_ms !== null) return toToken(row);
        const at = now();
        tx.update("tokens", row, { revoked_at_ms: at });
        return toToken({ ...row, revoked_at_ms: at });
      }),

    async verifyToken({ token }) {
      // Not a vault token's shape: no digest to look up.
      if (typeof token !== "string" || !isVaultToken(token)) {
        return { ok: false, reason: "unknown" } as const;
      }
      const row = await db.findOne("tokens", {
        hash: await hashVaultToken(token),
      });
      if (row === null) return { ok: false, reason: "unknown" } as const;
      if (row.revoked_at_ms !== null) {
        return { ok: false, reason: "revoked" } as const;
      }
      if (row.expires_at_ms !== null && row.expires_at_ms <= now()) {
        return { ok: false, reason: "expired" } as const;
      }
      return { ok: true, token: toToken(row) } as const;
    },

    async recordAudit({ entries }) {
      const rows = entries.map(toAuditRow);
      if (rows.length === 0) return;
      const at = now();
      await db.transaction(async (tx) => {
        for (const row of rows) tx.create("audit", { ...row, at_ms: at });
      });
    },
  } satisfies VaultApi);
};
