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
import { randomId } from "./token";

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

const MAX_METADATA_BYTES = 4 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PAGE_SIZE = 500;

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
      try {
        return await write(input);
      } catch (error) {
        // Another put created the name first; this one becomes its next version.
        if (
          error instanceof DatabaseConstraintError &&
          error.reason === "unique"
        ) {
          return write(input);
        }
        throw error;
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
  } satisfies VaultApi);
};
