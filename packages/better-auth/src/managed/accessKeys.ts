import {
  defineUniversalComponentSchema,
  type UniversalComponentDataSource,
  type UniversalComponentRow,
} from "@hot-updater/plugin-core";
import { createAccessControl } from "better-auth/plugins/access";

import { isCanonicalBase64Url32 } from "../base64url";

export const MANAGED_ACCESS_KEY_ENV_NAME = "HOT_UPDATER_API_KEY";
export const MANAGED_ACCESS_KEY_HEADER_NAME = "x-api-key";

export const managedAccessKeyStatements = {
  analytics: ["write"],
  ota: ["read"],
} as const;

const managedAccessControl = createAccessControl(managedAccessKeyStatements);
const managedAccessKeyRoles = {
  client: managedAccessControl.newRole({
    analytics: ["write"],
    ota: ["read"],
  }),
} as const;

export type ManagedAccessKeyRole = keyof typeof managedAccessKeyRoles;

export type ManagedAccessKeyRecord = {
  readonly createdAt: number;
  readonly enabled: boolean;
  readonly hash: string;
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly revokedAt: number | null;
  readonly role: ManagedAccessKeyRole;
};

export type ManagedAccessKeyStore = {
  readonly create: (
    record: ManagedAccessKeyRecord,
  ) => Promise<"created" | "existing">;
  readonly findByHash: (hash: string) => Promise<ManagedAccessKeyRecord | null>;
  readonly list: () => Promise<readonly ManagedAccessKeyRecord[]>;
  readonly revoke: (input: {
    readonly id: string;
    readonly revokedAt: number;
  }) => Promise<ManagedAccessKeyRecord | null>;
};

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

export const parseManagedAccessKeyStore = (
  value: unknown,
): ManagedAccessKeyStore => {
  if (
    !isObject(value) ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !["create", "findByHash", "list", "revoke"].includes(key),
    ) ||
    typeof Reflect.get(value, "create") !== "function" ||
    typeof Reflect.get(value, "findByHash") !== "function" ||
    typeof Reflect.get(value, "list") !== "function" ||
    typeof Reflect.get(value, "revoke") !== "function"
  ) {
    throw new TypeError("Invalid managed access-key store.");
  }
  return Object.freeze({
    create: Reflect.get(value, "create").bind(value),
    findByHash: Reflect.get(value, "findByHash").bind(value),
    list: Reflect.get(value, "list").bind(value),
    revoke: Reflect.get(value, "revoke").bind(value),
  });
};

const ACCESS_KEY_TABLE = "better_auth_managed_access_keys";
const ACCESS_KEY_REVOCATION_TABLE =
  "better_auth_managed_access_key_revocations";
const ACCESS_KEY_SCAN = "better_auth_managed_access_keys_by_created_at";
const ACCESS_KEY_PAGE_SIZE = 500;

export const managedAccessKeyComponentSchema = defineUniversalComponentSchema({
  id: "better-auth-managed-access-keys",
  versions: [
    {
      version: "1",
      tables: [
        {
          name: ACCESS_KEY_TABLE,
          columns: [
            { name: "id", primaryKey: true, type: "string" },
            { name: "hash", type: "string" },
            { name: "name", type: "string" },
            { name: "prefix", type: "string" },
            { name: "role", type: "string" },
            { name: "created_at_ms", type: "integer" },
          ],
          checks: [
            {
              expression: { column: "id", op: "non-empty" },
              name: "better_auth_managed_access_keys_id_present",
            },
            {
              expression: { column: "hash", op: "non-empty" },
              name: "better_auth_managed_access_keys_hash_present",
            },
            {
              expression: { column: "name", op: "non-empty" },
              name: "better_auth_managed_access_keys_name_present",
            },
            {
              expression: { column: "prefix", op: "non-empty" },
              name: "better_auth_managed_access_keys_prefix_present",
            },
            {
              expression: { column: "role", op: "eq", value: "client" },
              name: "better_auth_managed_access_keys_role_known",
            },
            {
              enforcement: "validation",
              expression: { column: "created_at_ms", op: "gte", value: 0 },
              name: "better_auth_managed_access_keys_created_at_valid",
            },
          ],
          indexes: [
            {
              columns: ["created_at_ms", "id"],
              name: "better_auth_managed_access_keys_created_at_idx",
            },
          ],
        },
        {
          name: ACCESS_KEY_REVOCATION_TABLE,
          columns: [
            { name: "id", primaryKey: true, type: "string" },
            { name: "revoked_at_ms", type: "integer" },
          ],
          checks: [
            {
              expression: { column: "id", op: "non-empty" },
              name: "better_auth_managed_access_key_revocations_id_present",
            },
            {
              enforcement: "validation",
              expression: { column: "revoked_at_ms", op: "gte", value: 0 },
              name: "better_auth_managed_access_key_revoked_at_valid",
            },
          ],
        },
      ],
      orderedScans: [
        {
          columns: ["created_at_ms", "id"],
          name: ACCESS_KEY_SCAN,
          table: ACCESS_KEY_TABLE,
        },
      ],
    },
  ],
});

const parseManagedAccessKeyRow = (
  row: UniversalComponentRow,
): ManagedAccessKeyRecord => {
  const { created_at_ms, hash, id, name, prefix, role } = row;
  if (
    typeof created_at_ms !== "number" ||
    !Number.isSafeInteger(created_at_ms) ||
    created_at_ms < 0 ||
    typeof hash !== "string" ||
    !isCanonicalBase64Url32(hash) ||
    typeof id !== "string" ||
    id !== managedAccessKeyId(hash) ||
    typeof name !== "string" ||
    normalizeManagedAccessKeyName(name) !== name ||
    typeof prefix !== "string" ||
    prefix.length !== 6 ||
    role !== "client"
  ) {
    throw new TypeError("Invalid managed access-key component row.");
  }
  return Object.freeze({
    createdAt: created_at_ms,
    enabled: true,
    hash,
    id,
    name,
    prefix,
    revokedAt: null,
    role,
  });
};

const parseRevokedAt = (row: UniversalComponentRow): number => {
  const { id, revoked_at_ms } = row;
  if (
    typeof id !== "string" ||
    typeof revoked_at_ms !== "number" ||
    !Number.isSafeInteger(revoked_at_ms) ||
    revoked_at_ms < 0
  ) {
    throw new TypeError("Invalid managed access-key revocation row.");
  }
  return revoked_at_ms;
};

const hashFromManagedAccessKeyId = (id: string): string | null => {
  const prefix = "managed-client-";
  const hash = id.startsWith(prefix) ? id.slice(prefix.length) : "";
  return isCanonicalBase64Url32(hash) && managedAccessKeyId(hash) === id
    ? hash
    : null;
};

export const createUniversalComponentManagedAccessKeyStore = (
  source: UniversalComponentDataSource,
  options: { readonly onRevoke?: () => Promise<void> } = {},
): ManagedAccessKeyStore => {
  if (source.schema !== managedAccessKeyComponentSchema) {
    throw new TypeError("Invalid managed access-key component source.");
  }

  const findByHash = async (
    hash: string,
  ): Promise<ManagedAccessKeyRecord | null> => {
    const id = managedAccessKeyId(hash);
    const row = await source.get({ primaryKey: id, table: ACCESS_KEY_TABLE });
    if (row === null) return null;
    const record = parseManagedAccessKeyRow(row);
    if (record.hash !== hash) {
      throw new TypeError("Invalid managed access-key component identity.");
    }
    const revocation = await source.get({
      primaryKey: id,
      table: ACCESS_KEY_REVOCATION_TABLE,
    });
    if (revocation === null) return record;
    return Object.freeze({
      ...record,
      enabled: false,
      revokedAt: parseRevokedAt(revocation),
    });
  };

  return Object.freeze({
    async create(record) {
      if (!record.enabled || record.revokedAt !== null) {
        throw new TypeError("Managed access keys must be created active.");
      }
      const row = {
        created_at_ms: record.createdAt,
        hash: record.hash,
        id: record.id,
        name: record.name,
        prefix: record.prefix,
        role: record.role,
      };
      parseManagedAccessKeyRow(row);
      return source.create({ row, table: ACCESS_KEY_TABLE });
    },
    findByHash,
    async list() {
      const records: ManagedAccessKeyRecord[] = [];
      let afterExclusive: readonly [number, string] | undefined;
      while (true) {
        const rows = await source.orderedScan({
          accessPattern: ACCESS_KEY_SCAN,
          ...(afterExclusive === undefined ? {} : { afterExclusive }),
          beforePrefixExclusive: [Number.MAX_SAFE_INTEGER, "\uffff"],
          limit: ACCESS_KEY_PAGE_SIZE,
        });
        for (const row of rows) {
          const record = parseManagedAccessKeyRow(row);
          records.push((await findByHash(record.hash))!);
        }
        if (rows.length < ACCESS_KEY_PAGE_SIZE) break;
        const last = parseManagedAccessKeyRow(rows.at(-1)!);
        afterExclusive = [last.createdAt, last.id];
      }
      return records.toSorted(
        (left, right) =>
          right.createdAt - left.createdAt || left.id.localeCompare(right.id),
      );
    },
    async revoke({ id, revokedAt }) {
      const hash = hashFromManagedAccessKeyId(id);
      if (hash === null || !Number.isSafeInteger(revokedAt) || revokedAt < 0) {
        return null;
      }
      const current = await findByHash(hash);
      if (current === null || current.revokedAt !== null) return current;
      const status = await source.create({
        row: { id, revoked_at_ms: revokedAt },
        table: ACCESS_KEY_REVOCATION_TABLE,
      });
      const revoked = await findByHash(hash);
      if (status === "created") await options.onRevoke?.();
      return revoked;
    },
  });
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

export const hashManagedAccessKey = async (apiKey: string): Promise<string> => {
  if (!isCanonicalBase64Url32(apiKey)) {
    throw new TypeError(
      `${MANAGED_ACCESS_KEY_ENV_NAME} must be a canonical 32-byte base64url value.`,
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(apiKey),
  );
  return bytesToBase64Url(new Uint8Array(digest));
};

export const managedAccessKeyId = (hash: string): string =>
  `managed-client-${hash}`;

export const normalizeManagedAccessKeyName = (name: string): string => {
  const normalized = name.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    throw new TypeError(
      "Managed access-key names must contain 1-64 visible characters.",
    );
  }
  return normalized;
};

export const registerManagedAccessKey = async (input: {
  readonly apiKey: string;
  readonly createdAt?: number;
  readonly name: string;
  readonly store: ManagedAccessKeyStore;
}): Promise<ManagedAccessKeyRecord> => {
  const hash = await hashManagedAccessKey(input.apiKey);
  const name = normalizeManagedAccessKeyName(input.name);
  const record = Object.freeze({
    createdAt: input.createdAt ?? Date.now(),
    enabled: true,
    hash,
    id: managedAccessKeyId(hash),
    name,
    prefix: input.apiKey.slice(0, 6),
    revokedAt: null,
    role: "client" as const,
  });
  const status = await input.store.create(record);
  if (status === "existing") {
    const existing = await input.store.findByHash(hash);
    if (existing === null || !existing.enabled || existing.revokedAt !== null) {
      throw new Error("The managed access key has been revoked.");
    }
    return existing;
  }
  return record;
};

export const authorizeManagedAccessKeyRole = (
  role: ManagedAccessKeyRole,
  permission: Parameters<
    (typeof managedAccessKeyRoles)["client"]["authorize"]
  >[0],
): boolean => managedAccessKeyRoles[role].authorize(permission).success;
