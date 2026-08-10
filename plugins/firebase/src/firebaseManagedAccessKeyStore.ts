import {
  managedAccessKeyId,
  type ManagedAccessKeyRecord,
  type ManagedAccessKeyStore,
} from "@hot-updater/better-auth/managed";
import type { DocumentData, Firestore } from "firebase-admin/firestore";

export const FIREBASE_MANAGED_ACCESS_KEY_COLLECTION = "managed_access_keys";

const parseRecord = (
  id: string,
  value: DocumentData | undefined,
): ManagedAccessKeyRecord => {
  if (value === undefined)
    throw new TypeError("Invalid managed access-key row.");
  const { createdAt, enabled, hash, name, prefix, revokedAt, role } = value;
  if (
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    typeof enabled !== "boolean" ||
    typeof hash !== "string" ||
    typeof name !== "string" ||
    typeof prefix !== "string" ||
    (revokedAt !== null &&
      (typeof revokedAt !== "number" || !Number.isSafeInteger(revokedAt))) ||
    role !== "client" ||
    id !== managedAccessKeyId(hash)
  ) {
    throw new TypeError("Invalid managed access-key row.");
  }
  return { createdAt, enabled, hash, id, name, prefix, revokedAt, role };
};

const toDocument = ({ id: _id, ...record }: ManagedAccessKeyRecord) => record;

export const createFirebaseManagedAccessKeyStore = (
  firestore: Firestore,
): ManagedAccessKeyStore => {
  const collection = firestore.collection(
    FIREBASE_MANAGED_ACCESS_KEY_COLLECTION,
  );
  return {
    async create(record) {
      const reference = collection.doc(record.id);
      return firestore.runTransaction(async (transaction) => {
        const existing = await transaction.get(reference);
        if (existing.exists) return "existing";
        transaction.create(reference, toDocument(record));
        return "created";
      });
    },
    async findByHash(hash) {
      const document = await collection.doc(managedAccessKeyId(hash)).get();
      return document.exists ? parseRecord(document.id, document.data()) : null;
    },
    async list() {
      const snapshot = await collection.get();
      return snapshot.docs
        .map((document) => parseRecord(document.id, document.data()))
        .sort(
          (left, right) =>
            right.createdAt - left.createdAt || left.id.localeCompare(right.id),
        );
    },
    async revoke({ id, revokedAt }) {
      const reference = collection.doc(id);
      return firestore.runTransaction(async (transaction) => {
        const document = await transaction.get(reference);
        if (!document.exists) return null;
        const record = parseRecord(document.id, document.data());
        if (!record.enabled || record.revokedAt !== null) return record;
        const revoked = { ...record, enabled: false, revokedAt };
        transaction.update(reference, {
          enabled: revoked.enabled,
          revokedAt: revoked.revokedAt,
        });
        return revoked;
      });
    },
  };
};
