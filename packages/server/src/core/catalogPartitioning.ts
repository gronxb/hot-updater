import {
  DatabaseConflictError,
  DatabaseConstraintError,
  DatabaseSnapshotUnsupportedError,
  type ReleaseCatalogPartitioningStatus,
} from "@hot-updater/plugin-core";

import { type CoreDatabase, PARTITIONS } from "./catalogReads";
import { PARTITIONING_SETTING } from "./catalogWrites";

/**
 * Turning release catalog partitioning on: the only product path that
 * writes the persisted `catalog.partitioning = on`. The server runs it with
 * its own credentials, behind one of two doors:
 *
 * - the admin route, which the server's framework authenticates;
 * - the client route, which a managed server mounts publicly, with a
 *   request token: a short-lived, single-use secret whose hash the caller
 *   first stored in the settings table. Writing it takes the database
 *   credentials that could write the switch itself, so the token adds no
 *   secret and grants nothing else; the server still checks everything
 *   below with its own credentials, and consumes the token in the write
 *   that sets the switch, or deletes it when it refuses.
 *
 * Nothing turns partitioning off.
 */

/** The settings row a request token's hash and expiry live in. */
export const PARTITIONING_REQUEST_SETTING = "catalog.partitioning.request";

/** How long a request token authorizes the enable after it is issued. */
export const PARTITIONING_REQUEST_TTL_MS = 10 * 60 * 1000;

/** How many times a lost settings write is read again before it refuses. */
const SWAPS = 5;

export type ReleaseCatalogPartitioningRefusal =
  | "PARTITIONS_UNAVAILABLE"
  | "PARTITIONS_KEY_ORDER"
  | "SNAPSHOT_UNSUPPORTED"
  | "PARTITIONING_CONFLICT";

/** The server can't turn partitioning on here; the switch stays unset. */
export class ReleaseCatalogPartitioningError extends Error {
  readonly name = "ReleaseCatalogPartitioningError";

  constructor(
    readonly code: ReleaseCatalogPartitioningRefusal,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * The request token is missing, expired, already used or wrong. One error
 * for every case, so the route says nothing about which.
 */
export class ReleaseCatalogPartitioningRequestError extends Error {
  readonly name = "ReleaseCatalogPartitioningRequestError";

  constructor() {
    super("The partitioning request is not valid.");
  }
}

export interface ReleaseCatalogPartitioningResult {
  readonly partitioning: "on";
  /** False when the switch was already on. */
  readonly changed: boolean;
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const toHex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const sha256Hex = async (text: string) =>
  toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

/** Equal-length strings compared without an early exit. */
const sameText = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
};

interface StoredRequest {
  readonly hash: string;
  readonly expiresAtMs: number;
}

const parseRequest = (value: string | null): StoredRequest | null => {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as StoredRequest).hash === "string" &&
      typeof (parsed as StoredRequest).expiresAtMs === "number"
    ) {
      return parsed as StoredRequest;
    }
  } catch {
    // A row this code didn't write authorizes nothing.
  }
  return null;
};

/**
 * Whether the partitions table answers a limit-1 read with the server's
 * credentials: a missing table, a role without a grant, an IAM policy that
 * predates it, or the Supabase RPC's allowlist all throw here.
 */
const tableReadable = async (db: CoreDatabase): Promise<unknown> => {
  try {
    await db.findMany(PARTITIONS, {
      index: "byScope",
      where: { scope_key: "~" },
      limit: 1,
    });
    return null;
  } catch (error) {
    return error ?? new Error("The read failed");
  }
};

/** The switch, and whether the server can read the partitions table. */
export const readReleaseCatalogPartitioning = async (
  db: CoreDatabase,
): Promise<ReleaseCatalogPartitioningStatus> => {
  const [setting, failure] = await Promise.all([
    db.readSetting(PARTITIONING_SETTING),
    tableReadable(db),
  ]);
  return {
    switch: setting === "on" ? "on" : "off",
    table: failure === null ? "present" : "missing",
  };
};

/**
 * Stores a new request token's hash with its expiry, replacing any earlier
 * one, and returns the token. The caller writes it with its own database
 * credentials, then hands the token to the server's client route.
 */
export const issueReleaseCatalogPartitioningToken = async (
  db: CoreDatabase,
  now: () => number,
): Promise<string> => {
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const value = JSON.stringify({
    hash: await sha256Hex(token),
    expiresAtMs: now() + PARTITIONING_REQUEST_TTL_MS,
  });
  for (let attempt = 0; attempt < SWAPS; attempt++) {
    const current = await db.readSetting(PARTITIONING_REQUEST_SETTING);
    if (
      await db.swapSettings([
        { key: PARTITIONING_REQUEST_SETTING, expected: current, value },
      ])
    ) {
      return token;
    }
  }
  throw new ReleaseCatalogPartitioningError(
    "PARTITIONING_CONFLICT",
    "The partitioning request kept changing; try again.",
  );
};

/**
 * The probe's six keys, under a scope key no canonical scope key can equal:
 * `!` < `#` < `0`, `A` < `_` < `a`, and a prefix before its extension, in
 * byte order. A case-insensitive collation makes `A` and `a` collide.
 */
const PROBE_KEYS = [
  ["!", "!"],
  ["#", "a"],
  ["0a", "A"],
  ["0a", "_"],
  ["0a", "a"],
  ["0a", "a!"],
] as const;

const probeOrder = (rows: readonly { epoch: string; lower_key: string }[]) =>
  rows.map(({ epoch, lower_key }) => `${epoch}/${lower_key}`).join(" ");

/**
 * Writes the six probe rows, reads them back as production reads
 * partitions (through a snapshot where the adapter takes one), and checks
 * byte order, inclusive and exclusive predecessors. Deletes them whatever
 * happens. Returns why the order is wrong, or null.
 */
const probeKeyOrder = async (db: CoreDatabase): Promise<string | null> => {
  const scopeKey = `~probe/${toHex(crypto.getRandomValues(new Uint8Array(8)))}`;
  const keys = PROBE_KEYS.map(([epoch, lower_key]) => ({
    scope_key: scopeKey,
    epoch,
    lower_key,
  }));
  try {
    try {
      // One row a write, so a key a collation folds into an earlier one
      // fails as that key's conflict, not as a write that rolled back.
      for (const key of keys) {
        await db.transaction(async (tx) => {
          tx.create(PARTITIONS, {
            ...key,
            generation: 0,
            payload: "{}",
            partition_hash: "probe",
            byte_size: 2,
          });
        });
      }
    } catch (error) {
      // `A` and `a` are one key under a case-insensitive collation: the
      // store refuses the second as a duplicate, which reads back as a
      // conflict that never clears, since its exact key is still absent. A
      // fresh scope key has no other writer.
      if (
        error instanceof DatabaseConstraintError ||
        error instanceof DatabaseConflictError
      ) {
        return `two of its keys collide (${errorMessage(error)})`;
      }
      throw error;
    }
    const expected = probeOrder(keys);
    return await db.snapshot(async (reader) => {
      const page = (
        range: Record<string, readonly string[]>,
        order: "asc" | "desc",
        limit: number,
      ) =>
        reader.findMany(PARTITIONS, {
          index: "byScope",
          where: { scope_key: scopeKey },
          range,
          order,
          limit,
        });
      const all = await page({}, "asc", 10);
      if (probeOrder(all.rows) !== expected) {
        return `it reads ${probeOrder(all.rows)}`;
      }
      const reversed = await page({}, "desc", 10);
      if (probeOrder([...reversed.rows].reverse()) !== expected) {
        return `it reads ${probeOrder(reversed.rows)} descending`;
      }
      const checks: [Record<string, readonly string[]>, string][] = [
        [{ lte: ["0a", "a"] }, "0a/a"],
        [{ lt: ["0a", "a"] }, "0a/_"],
        [{ lt: ["0a", ""] }, "#/a"],
      ];
      for (const [range, want] of checks) {
        const { rows } = await page(range, "desc", 1);
        const found = probeOrder(rows);
        if (found !== want) {
          return `the row before ${JSON.stringify(range)} is ${found || "none"}, not ${want}`;
        }
      }
      return null;
    });
  } finally {
    await db
      .transaction(async (tx) => {
        for (const key of keys) {
          const row = await tx.findOne(PARTITIONS, key);
          if (row !== null) await tx.delete(PARTITIONS, row);
        }
      })
      .catch(() => undefined);
  }
};

/**
 * Checks the partitions table with the server's credentials, then sets the
 * switch. With `token`, the request token must match the stored one and be
 * unexpired; it is consumed in the write that sets the switch, or deleted
 * when the server refuses. Idempotent: an `on` switch answers unchanged.
 * Concurrent calls set the switch once, and a token authorizes one call.
 */
export const enableReleaseCatalogPartitioning = async (
  db: CoreDatabase,
  now: () => number,
  input: { readonly token?: string } = {},
): Promise<ReleaseCatalogPartitioningResult> => {
  let request: string | null = null;
  if (input.token !== undefined) {
    request = await db.readSetting(PARTITIONING_REQUEST_SETTING);
    const stored = parseRequest(request);
    if (
      stored === null ||
      stored.expiresAtMs <= now() ||
      !sameText(stored.hash, await sha256Hex(input.token))
    ) {
      throw new ReleaseCatalogPartitioningRequestError();
    }
  }
  /** Deletes the token this call holds; false when another call took it. */
  const consume = async () =>
    request === null ||
    db.swapSettings([
      { key: PARTITIONING_REQUEST_SETTING, expected: request, value: null },
    ]);
  const refuse = async (error: ReleaseCatalogPartitioningError) => {
    if (!(await consume())) throw new ReleaseCatalogPartitioningRequestError();
    throw error;
  };

  if ((await db.readSetting(PARTITIONING_SETTING)) === "on") {
    if (!(await consume())) throw new ReleaseCatalogPartitioningRequestError();
    return { partitioning: "on", changed: false };
  }

  // A missing table, a role without a grant, or an IAM policy that predates
  // the table fails the probe's first write.
  let order: string | null;
  try {
    order = await probeKeyOrder(db);
  } catch (error) {
    if (error instanceof DatabaseSnapshotUnsupportedError) {
      return refuse(
        new ReleaseCatalogPartitioningError(
          "SNAPSHOT_UNSUPPORTED",
          error.message,
          { cause: error },
        ),
      );
    }
    return refuse(
      new ReleaseCatalogPartitioningError(
        "PARTITIONS_UNAVAILABLE",
        `The server can't read and write release_catalog_partitions: ${errorMessage(error)}`,
        { cause: error },
      ),
    );
  }
  if (order !== null) {
    return refuse(
      new ReleaseCatalogPartitioningError(
        "PARTITIONS_KEY_ORDER",
        `release_catalog_partitions doesn't keep keys in byte order: ${order}. Recreate it from the 1.2.0 migration.`,
      ),
    );
  }

  for (let attempt = 0; attempt < SWAPS; attempt++) {
    const changes = [
      { key: PARTITIONING_SETTING, expected: null, value: "on" },
      ...(request === null
        ? []
        : [
            {
              key: PARTITIONING_REQUEST_SETTING,
              expected: request,
              value: null,
            },
          ]),
    ];
    if (await db.swapSettings(changes)) {
      return { partitioning: "on", changed: true };
    }
    const [switched, held] = await Promise.all([
      db.readSetting(PARTITIONING_SETTING),
      request === null ? null : db.readSetting(PARTITIONING_REQUEST_SETTING),
    ]);
    // Another call consumed this token.
    if (request !== null && held !== request) {
      throw new ReleaseCatalogPartitioningRequestError();
    }
    if (switched === "on") {
      if (!(await consume())) {
        throw new ReleaseCatalogPartitioningRequestError();
      }
      return { partitioning: "on", changed: false };
    }
  }
  return refuse(
    new ReleaseCatalogPartitioningError(
      "PARTITIONING_CONFLICT",
      "The settings kept changing; try again.",
    ),
  );
};
