import type { BundleChangeV2 } from "./bundles";
import {
  canonicalizeDatabaseValueV1,
  snapshotCanonicalDatabaseValueV1,
} from "./canonicalIdentity";
import type { AssertedDatabaseScope, Sha256Digest } from "./common";
import { DatabaseConnectorErrorV2 } from "./errors";
import type { DatabaseManifestTupleV2 } from "./manifest";
import { parseDatabaseManifestTupleV2 } from "./manifestValidation";
import { encodeUtf8V2 } from "./utf8";

const CHANGE_SET_DOMAIN = "hot-updater.database.change-set.v1\0";
const HEX_NIBBLES = Object.freeze([
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
]);
const MANIFEST_DOMAIN = "hot-updater.database.manifest.v1\0";
const SCOPE_DOMAIN = "hot-updater.database.scope.v1\0";
const Uint8ArrayConstructor = Uint8Array;
const reflectApply = Reflect.apply;
const setUint8Array = Uint8Array.prototype.set;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;
const typedArrayTag = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get;

const defaultSha256: Sha256Digest = async (
  bytes: Uint8Array,
): Promise<Uint8Array> => {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new DatabaseConnectorErrorV2(
      "DIGEST_UNAVAILABLE",
      "WebCrypto SHA-256 is unavailable",
    );
  }
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
};

const digestIdentity = async (
  domain: string,
  value: unknown,
  sha256: Sha256Digest | undefined,
): Promise<string> => {
  const bytes = encodeUtf8V2(`${domain}${canonicalizeDatabaseValueV1(value)}`);
  let digest: Uint8Array;
  try {
    digest = await (sha256 ?? defaultSha256)(bytes);
  } catch (error) {
    if (
      sha256 === undefined &&
      error instanceof DatabaseConnectorErrorV2 &&
      error.code === "DIGEST_UNAVAILABLE"
    ) {
      throw error;
    }
    throw new DatabaseConnectorErrorV2(
      "DIGEST_UNAVAILABLE",
      "SHA-256 provider failed",
    );
  }
  let digestLength: number;
  try {
    if (
      typedArrayByteLength === undefined ||
      typedArrayTag === undefined ||
      reflectApply(typedArrayTag, digest, []) !== "Uint8Array"
    ) {
      throw new TypeError("digest is not a Uint8Array");
    }
    digestLength = reflectApply(typedArrayByteLength, digest, []);
  } catch {
    throw new DatabaseConnectorErrorV2(
      "DIGEST_UNAVAILABLE",
      "SHA-256 provider returned an unreadable digest",
    );
  }
  if (digestLength !== 32) {
    throw new DatabaseConnectorErrorV2(
      "DIGEST_UNAVAILABLE",
      "SHA-256 provider must return exactly 32 bytes",
    );
  }
  let digestSnapshot: Uint8Array;
  try {
    digestSnapshot = new Uint8ArrayConstructor(32);
    reflectApply(setUint8Array, digestSnapshot, [digest]);
  } catch {
    throw new DatabaseConnectorErrorV2(
      "DIGEST_UNAVAILABLE",
      "SHA-256 provider returned an unreadable digest",
    );
  }
  let hex = "";
  for (let index = 0; index < digestLength; index += 1) {
    const byte = digestSnapshot[index];
    hex += HEX_NIBBLES[byte >> 4] + HEX_NIBBLES[byte & 0x0f];
  }
  return `sha256:${hex}`;
};

const captureScopeIdentity = (scope: unknown) => {
  try {
    if (
      typeof scope !== "object" ||
      scope === null ||
      Array.isArray(scope) ||
      Object.getPrototypeOf(scope) !== Object.prototype ||
      Object.getOwnPropertySymbols(scope).length > 0
    ) {
      throw new DatabaseConnectorErrorV2(
        "CANONICALIZATION_FAILED",
        "scope identity must be a plain object without symbol keys",
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(scope);
    const keys = Object.keys(descriptors);
    if (
      keys.some(
        (key) =>
          key !== "tenantId" &&
          key !== "principalId" &&
          key !== "context" &&
          key !== "scopeId",
      )
    ) {
      throw new DatabaseConnectorErrorV2(
        "CANONICALIZATION_FAILED",
        "scope identity has an invalid shape",
      );
    }
    const tenant = Reflect.get(descriptors, "tenantId");
    const principal = Reflect.get(descriptors, "principalId");
    if (
      tenant === undefined ||
      principal === undefined ||
      tenant.enumerable !== true ||
      principal.enumerable !== true ||
      Object.hasOwn(tenant, "get") ||
      Object.hasOwn(tenant, "set") ||
      Object.hasOwn(principal, "get") ||
      Object.hasOwn(principal, "set") ||
      typeof tenant.value !== "string" ||
      tenant.value.trim().length === 0 ||
      typeof principal.value !== "string" ||
      principal.value.trim().length === 0
    ) {
      throw new DatabaseConnectorErrorV2(
        "CANONICALIZATION_FAILED",
        "scope identifiers must be enumerable non-empty string data properties",
      );
    }
    return { principalId: principal.value, tenantId: tenant.value };
  } catch (error) {
    if (error instanceof DatabaseConnectorErrorV2) {
      throw error;
    }
    throw new DatabaseConnectorErrorV2(
      "CANONICALIZATION_FAILED",
      "scope identity could not be inspected safely",
    );
  }
};

export const hashDatabaseChangeSetPayloadV1 = (
  changes: readonly BundleChangeV2[],
  sha256?: Sha256Digest,
): Promise<string> => digestIdentity(CHANGE_SET_DOMAIN, { changes }, sha256);

export const hashDatabaseScopeV1 = async (
  scope: Pick<AssertedDatabaseScope<unknown>, "tenantId" | "principalId">,
  sha256?: Sha256Digest,
): Promise<string> =>
  await digestIdentity(SCOPE_DOMAIN, captureScopeIdentity(scope), sha256);

export const hashDatabaseManifestTupleV1 = (
  tuple: DatabaseManifestTupleV2,
  sha256?: Sha256Digest,
): Promise<string> => {
  const snapshot = snapshotCanonicalDatabaseValueV1<unknown>(tuple);
  return digestIdentity(
    MANIFEST_DOMAIN,
    parseDatabaseManifestTupleV2(snapshot),
    sha256,
  );
};
