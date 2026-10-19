import {
  DatabaseConstraintError,
  type DatabaseJson,
  type HotUpdaterDatabase,
} from "@hot-updater/plugin-core";

import {
  importMasterKey,
  open,
  seal,
  VAULT_MASTER_KEY_ENV,
  VaultIntegrityError,
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
 * What a token may do with the secrets in its scope: `read` their values, or
 * `sign` with them, which the Console's remote signing serves.
 */
export const VAULT_TOKEN_ACTIONS = ["read", "sign"] as const;

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

/** What an audit entry records: a list of secrets, or a read of their values. */
export const VAULT_AUDIT_ACTIONS = ["list", "read"] as const;

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

/** `hotUpdater.api.vault`. */
export interface VaultApi {
  /** Every secret but removed ones, by name, without values. */
  list(): Promise<readonly VaultSecret[]>;
  /**
   * Stores `value` as the next version of the secret `name`, creating it,
   * or bringing back a removed one, as needed. `metadata` replaces the
   * secret's when given. Throws `VaultLockedError` without a master key.
   */
  put(input: {
    readonly name: string;
    readonly kind: VaultSecretKind;
    readonly value: unknown;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<VaultSecret>;
  /** Removes a secret and deletes its values; null when there is none. */
  remove(input: { readonly id: string }): Promise<VaultSecret | null>;
  /**
   * The current value of a secret. Throws `VaultNotFoundError` when there is
   * no such secret, `VaultLockedError` without the master key that sealed
   * it, and `VaultIntegrityError` when its stored value does not decrypt.
   */
  reveal(input: {
    readonly id: string;
    /** Who reads the value, a token id or a Console user's email. */
    readonly actor: string;
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

/** No secret has the id, or it was removed. */
export class VaultNotFoundError extends Error {
  override readonly name = "VaultNotFoundError";
}

export interface VaultOptions {
  /**
   * The master key, 32 bytes in base64. Defaults to the
   * `HOT_UPDATER_VAULT_MASTER_KEY` environment variable when the vault seals
   * or opens a value. Without one, `list` and `remove` work, and `put` and
   * `reveal` throw `VaultLockedError`.
   */
  readonly masterKey?: string;
}

const readEnv = (name: string): string | undefined =>
  (
    globalThis as {
      readonly process?: { readonly env?: Record<string, string | undefined> };
    }
  ).process?.env?.[name];

/** Resolves the master key on each use, so a vault without one still lists. */
const masterKeyResolver = (options: VaultOptions) => {
  let cached:
    | { readonly encoded: string; readonly key: Promise<VaultMasterKey> }
    | undefined;
  return (): Promise<VaultMasterKey> => {
    const encoded = options.masterKey ?? readEnv(VAULT_MASTER_KEY_ENV);
    if (encoded === undefined || encoded.trim().length === 0) {
      return Promise.reject(
        new VaultLockedError(
          `The vault is locked: set ${VAULT_MASTER_KEY_ENV} where the Console runs to seal and reveal secrets.`,
        ),
      );
    }
    if (cached?.encoded !== encoded) {
      cached = { encoded, key: importMasterKey(encoded) };
    }
    return cached.key;
  };
};

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
 * signing key's secret like `read`. It checks only the scope; pass a token
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
  const masterKey = masterKeyResolver(options);

  const write = (input: {
    readonly name: string;
    readonly kind: VaultSecretKind;
    readonly plaintext: Uint8Array<ArrayBuffer>;
    readonly metadata: Readonly<Record<string, DatabaseJson>> | undefined;
    readonly key: VaultMasterKey;
  }) =>
    db.transaction(async (tx) => {
      const at = now();
      const existing = await tx.findOne("secrets", { name: input.name });
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
      tx.create("secret_versions", {
        secret_id: id,
        version,
        ...(await seal({
          masterKey: input.key,
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
          if (row.deleted_at_ms === null) secrets.push(toSecret(row));
        }
        cursor = page.next;
      } while (cursor !== undefined);
      return Object.freeze(secrets);
    },

    async put({ name, kind, value, metadata }) {
      const input = {
        name: normalizeName(name),
        kind: normalizeKind(kind),
        plaintext: encodeValue(value),
        metadata:
          metadata === undefined ? undefined : normalizeMetadata(metadata),
        key: await masterKey(),
      };
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await write(input);
        } catch (error) {
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

    remove: ({ id }) =>
      db.transaction(async (tx) => {
        const row = await tx.findOne("secrets", { id });
        if (row === null || row.deleted_at_ms !== null) return null;
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

    async reveal({ id }) {
      const key = await masterKey();
      const row = await db.findOne("secrets", { id });
      if (row === null || row.deleted_at_ms !== null) {
        throw new VaultNotFoundError(`No secret has the id "${id}".`);
      }
      const sealed = await db.findOne("secret_versions", {
        secret_id: id,
        version: row.current_version,
      });
      if (sealed === null) {
        throw new VaultIntegrityError(
          `The secret "${row.name}" has no version ${row.current_version}.`,
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
      const rows = entries.map((entry) => {
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
            entry.context === undefined
              ? {}
              : normalizeAuditContext(entry.context),
        };
      });
      if (rows.length === 0) return;
      const at = now();
      await db.transaction(async (tx) => {
        for (const row of rows) tx.create("audit", { ...row, at_ms: at });
      });
    },
  } satisfies VaultApi);
};
