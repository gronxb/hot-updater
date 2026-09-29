import { createHash } from "node:crypto";

import type {
  KeyValueStore,
  KvCondition,
  KvKey,
  StoredRow,
} from "@hot-updater/server/database";
import {
  FieldPath,
  FieldValue,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
} from "firebase-admin/firestore";

/**
 * Firestore's limits: 10 MiB a request and 1 MiB a document; 500 writes a
 * transaction stays a conservative bound. Indexed values over 1,500 bytes are
 * truncated, so longer keys are refused rather than read inconsistently.
 */
export const FIRESTORE_LIMITS = {
  items: 500,
  bytes: 10_000_000,
  itemBytes: 1_000_000,
  keyBytes: { pk: 1_500, sk: 1_500 },
} as const;

/** `getAll` reads at most this many documents a call. */
const GET_BATCH = 300;

/** A document's id: a hash of its key, since keys may hold `/` and outgrow Firestore's 1,500 bytes. */
export const firestoreDocumentId = ({ pk, sk }: KvKey) =>
  createHash("sha256")
    .update(JSON.stringify([pk, sk]))
    .digest("hex");

/**
 * A document is `{ pk, sk, row }`. Row values that are maps or arrays become
 * JSON text inside a map, since Firestore has no nested arrays and does not
 * keep map key order; `row` is exempt from single-field indexing.
 */
const encode = (value: unknown) =>
  value !== null && typeof value === "object"
    ? { json: JSON.stringify(value) }
    : value;
const decode = (value: unknown) =>
  value !== null && typeof value === "object" && "json" in value
    ? JSON.parse(String((value as { json: unknown }).json))
    : value;

const toDocument = (key: KvKey, row: StoredRow): DocumentData => ({
  pk: key.pk,
  sk: key.sk,
  row: Object.fromEntries(
    Object.entries(row).map(([name, value]) => [name, encode(value)]),
  ),
});

const toRow = (data: DocumentData): StoredRow =>
  Object.fromEntries(
    Object.entries((data.row ?? {}) as Record<string, unknown>).map(
      ([name, value]) => [name, decode(value)],
    ),
  ) as StoredRow;

const holds = (
  snapshot: DocumentSnapshot | undefined,
  condition: KvCondition | undefined,
) => {
  if (condition === undefined) return true;
  const data = snapshot?.exists ? snapshot.data() : undefined;
  return "v" in condition
    ? data !== undefined && data.row?._v === condition.v
    : (data !== undefined) === condition.exists;
};

/** gRPC codes a rerun of the whole write can clear: DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, INTERNAL, UNAVAILABLE. */
const TRANSIENT = new Set([4, 8, 10, 13, 14]);

const codeOf = (error: unknown) => (error as { code?: unknown }).code as number;

/** Firestore reports a missing database as NOT_FOUND; it reads as a missing schema, like SQL's 42P01. */
const missingDatabase = (error: unknown): never => {
  throw codeOf(error) === 5
    ? Object.assign(new Error((error as Error).message, { cause: error }), {
        code: "42P01",
      })
    : error;
};

export interface FirestoreStoreOptions {
  readonly firestore: Firestore;
  /** The one collection every item lives in. */
  readonly collection: string;
  /** Test-only: the most items one `query` page returns. */
  readonly nativePageSize?: number;
}

/**
 * The key-value store over one Firestore collection of `{ pk, sk, row }`
 * documents, queried through the composite indexes on (pk, sk) in both
 * directions. A write is one transaction that reads only the documents its
 * ops guard.
 */
export const createFirestoreStore = ({
  firestore,
  collection,
  nativePageSize,
}: FirestoreStoreOptions): KeyValueStore => {
  const items = firestore.collection(collection);
  const reference = (key: KvKey) => items.doc(firestoreDocumentId(key));
  return {
    id: "firestore",
    limits: FIRESTORE_LIMITS,
    async get(keys) {
      const found = new Map<string, StoredRow>();
      const ids = [...new Set(keys.map(firestoreDocumentId))];
      for (let at = 0; at < ids.length; at += GET_BATCH) {
        const snapshots = await firestore
          .getAll(...ids.slice(at, at + GET_BATCH).map((id) => items.doc(id)))
          .catch(missingDatabase);
        for (const snapshot of snapshots) {
          if (snapshot.exists) found.set(snapshot.id, toRow(snapshot.data()!));
        }
      }
      return keys.map((key) => found.get(firestoreDocumentId(key)) ?? null);
    },
    async query({ pk, gte, lt, order, limit, after }) {
      let query = items.where("pk", "==", pk);
      if (gte !== undefined) query = query.where("sk", ">=", gte);
      if (lt !== undefined) query = query.where("sk", "<", lt);
      query = query.orderBy("sk", order);
      if (after !== undefined) query = query.startAfter(after);
      const size = Math.min(limit, nativePageSize ?? limit);
      const { docs } = await query.limit(size).get().catch(missingDatabase);
      return {
        items: docs.map((document) => ({
          sk: document.get("sk") as string,
          value: toRow(document.data()),
        })),
        more: docs.length === size,
      };
    },
    async write(ops) {
      // An add with no `_v` guard increments blind, holding no read lock on a
      // hot counter: `update` needs the document, so a missing one fails the
      // commit, and the write reruns reading it.
      const blind = ops.map(
        (op) =>
          op.type === "add" &&
          (op.condition === undefined ||
            ("exists" in op.condition && op.condition.exists)),
      );
      const attempt = (reading: boolean) =>
        firestore.runTransaction(
          async (transaction) => {
            const read = ops.flatMap((op, position) =>
              (op.condition !== undefined || op.type === "add") &&
              (reading || !blind[position])
                ? [position]
                : [],
            );
            // Reads first, as Firestore requires.
            const snapshots = new Map<number, DocumentSnapshot>();
            if (read.length > 0) {
              const found = await transaction.getAll(
                ...read.map((position) => reference(ops[position]!.key)),
              );
              read.forEach((position, at) =>
                snapshots.set(position, found[at]!),
              );
            }
            const failed = read.find(
              (position) =>
                !holds(snapshots.get(position), ops[position]!.condition),
            );
            if (failed !== undefined) {
              // A blind add before it may fail first, so read that too.
              if (!reading && blind.slice(0, failed).includes(true)) {
                return null;
              }
              return { ok: false, failedOp: failed } as const;
            }
            for (const [position, op] of ops.entries()) {
              const document = reference(op.key);
              if (op.type === "put") {
                transaction.set(document, toDocument(op.key, op.value));
              } else if (op.type === "delete") {
                transaction.delete(document);
              } else if (op.type === "add") {
                if (snapshots.get(position)?.exists === false) {
                  // A missing item starts from `init`, then adds.
                  const created: Record<string, unknown> = { ...op.init };
                  for (const [name, delta] of Object.entries(op.by)) {
                    created[name] = Number(created[name] ?? 0) + delta;
                  }
                  transaction.set(
                    document,
                    toDocument(op.key, created as StoredRow),
                  );
                } else {
                  // `by` always holds `_v`; field paths keep column names literal.
                  const [[name, delta], ...more] = Object.entries(op.by) as [
                    [string, number],
                    ...[string, number][],
                  ];
                  transaction.update(
                    document,
                    new FieldPath("row", name),
                    FieldValue.increment(delta),
                    ...more.flatMap(([other, by]) => [
                      new FieldPath("row", other),
                      FieldValue.increment(by),
                    ]),
                  );
                }
              }
            }
            return { ok: true } as const;
          },
          // Contended transactions abort; Firestore reruns this one, reads
          // included, with backoff, before the engine sees a retry.
          { maxAttempts: 5 },
        );
      try {
        try {
          const result = await attempt(false);
          if (result !== null) return result;
        } catch (error) {
          // NOT_FOUND: a blind add's document is missing, or the database is.
          if (codeOf(error) !== 5 || !blind.includes(true)) throw error;
        }
        return (await attempt(true))!;
      } catch (error) {
        if (TRANSIENT.has(codeOf(error))) return { ok: false, retry: true };
        return missingDatabase(error);
      }
    },
    async dispose() {},
  };
};
