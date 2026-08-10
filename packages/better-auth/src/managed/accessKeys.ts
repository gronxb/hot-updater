import type { CapabilityToken } from "@hot-updater/plugin-core";
import {
  attachCapabilityContribution,
  defineSharedCapability,
} from "@hot-updater/plugin-core/internal/capabilities";
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

export const managedAccessKeyStoreCapability: CapabilityToken<ManagedAccessKeyStore> =
  defineSharedCapability({
    id: "hot-updater.better-auth.managed-access-key-store@1",
    parse: parseManagedAccessKeyStore,
  });

type ManagedAccessKeyStoreCarrier<TCarrier extends object> = TCarrier extends (
  ...args: never[]
) => unknown
  ? never
  : TCarrier;

export const attachManagedAccessKeyStore = <TCarrier extends object>(
  carrier: ManagedAccessKeyStoreCarrier<TCarrier>,
  createStore: () => ManagedAccessKeyStore,
): TCarrier =>
  attachCapabilityContribution(carrier, {
    create: createStore,
    token: managedAccessKeyStoreCapability,
  });

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
