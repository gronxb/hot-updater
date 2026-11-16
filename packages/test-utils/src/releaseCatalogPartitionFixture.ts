import {
  type CompiledReleaseCatalog,
  createEngine,
  type DatabaseAdapter,
  type ReleaseCatalogPartition,
  type ReleaseCatalogRow,
  SETTINGS_TABLE,
  tileCompiledReleaseCatalog,
} from "@hot-updater/plugin-core";

/** The persisted switch core's writers read: `on` partitions app-version scopes. */
export const RELEASE_CATALOG_PARTITIONING_SETTING = "catalog.partitioning";

/**
 * Turns partitioning on by inserting the settings row through the adapter,
 * as nothing in the product can yet: test-only, for specs of the write
 * path and of released cores sharing a database. `off` deletes the row,
 * which the product never does either.
 */
export const setReleaseCatalogPartitioning = async (
  adapter: DatabaseAdapter,
  state: "on" | "off",
): Promise<void> => {
  const key = RELEASE_CATALOG_PARTITIONING_SETTING;
  const [current] = await adapter.get(SETTINGS_TABLE, [[key]]);
  if (state === "on") {
    if (current?.value === "on") return;
    const result = await adapter.write([
      current
        ? {
            type: "patch",
            table: SETTINGS_TABLE,
            key: [key],
            set: { value: "on" },
            guard: { v: Number(current._v) },
            previous: current,
          }
        : {
            type: "insert",
            table: SETTINGS_TABLE,
            row: { key, value: "on", _v: 0 },
          },
    ]);
    if (!result.ok) throw new Error("The partitioning setting changed");
    return;
  }
  if (current === null || current === undefined) return;
  const result = await adapter.write([
    {
      type: "delete",
      table: SETTINGS_TABLE,
      key: [key],
      guard: { v: Number(current._v) },
      previous: current,
    },
  ]);
  if (!result.ok) throw new Error("The partitioning setting changed");
};

/** A partition row as `release_catalog_partitions` stores it. */
export interface ReleaseCatalogPartitionRowFixture {
  readonly epoch: string;
  readonly lowerKey: string;
  readonly generation: number;
  readonly partition: ReleaseCatalogPartition;
}

/** A partitioned scope's head payload, in canonical key order. */
export const releaseCatalogHeadPayload = (epoch: string): string =>
  JSON.stringify({
    epoch,
    layout: "partitioned",
    partitioning: 1,
    strategy: "APP_VERSION",
  });

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Rows per transaction, under every adapter's atomic limit. */
const CHUNK = 20;

/**
 * Test-only writers of partitioned release catalogs, through the engine
 * over `adapter`: no product code writes `release_catalog_partitions` yet,
 * so specs convert scopes and replay the writes a partitioning writer makes
 * with these.
 *
 * - `partition` converts a stored compact catalog in place: the head keeps
 *   its `catalog_id`, generation and `catalog_hash`, and its rows, stamped
 *   at that generation under a new epoch, tile the same catalog. Every
 *   answer before and after must be equal.
 * - `publishHead`, `publishCompact`, `writeRows` and `deleteRows` are the
 *   pieces of later writes: a head at a new generation over new or
 *   rewritten rows, a compact row replacing a head, and staged or retired
 *   rows.
 */
export const createReleaseCatalogPartitionFixture = (
  adapter: DatabaseAdapter,
) => {
  const db = createEngine({ name: "partition-fixture", adapter }).core;

  const readRow = async (scopeKey: string): Promise<ReleaseCatalogRow> => {
    const row = await db.findOne("release_catalogs", { scope_key: scopeKey });
    if (row === null) throw new Error(`No release catalog for ${scopeKey}`);
    return row as unknown as ReleaseCatalogRow;
  };

  /** Inserts rows in chunks; rows of an epoch no head names are invisible. */
  const writeRows = async (
    scopeKey: string,
    rows: readonly ReleaseCatalogPartitionRowFixture[],
  ) => {
    for (let at = 0; at < rows.length; at += CHUNK) {
      await db.transaction(async (tx) => {
        for (const row of rows.slice(at, at + CHUNK)) {
          tx.create("release_catalog_partitions", {
            byte_size: row.partition.byteSize,
            epoch: row.epoch,
            generation: row.generation,
            lower_key: row.lowerKey,
            partition_hash: row.partition.partitionHash,
            payload: row.partition.payload,
            scope_key: scopeKey,
          });
        }
      });
    }
  };

  /** Deletes rows by key, in chunks. */
  const deleteRows = async (
    scopeKey: string,
    keys: readonly { readonly epoch: string; readonly lowerKey: string }[],
  ) => {
    for (let at = 0; at < keys.length; at += CHUNK) {
      await db.transaction(async (tx) => {
        for (const { epoch, lowerKey } of keys.slice(at, at + CHUNK)) {
          const row = await tx.findOne("release_catalog_partitions", {
            epoch,
            lower_key: lowerKey,
            scope_key: scopeKey,
          });
          if (row !== null) await tx.delete("release_catalog_partitions", row);
        }
      });
    }
  };

  /** Every stored row of a scope, every epoch, in key order. */
  const rows = async (
    scopeKey: string,
  ): Promise<ReleaseCatalogPartitionRowFixture[]> => {
    const found: ReleaseCatalogPartitionRowFixture[] = [];
    let cursor: string | undefined;
    do {
      const page = await db.findMany("release_catalog_partitions", {
        index: "byScope",
        where: { scope_key: scopeKey },
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const row of page.rows) {
        found.push({
          epoch: row.epoch,
          generation: row.generation,
          lowerKey: row.lower_key,
          partition: {
            byteSize: row.byte_size,
            lowerKey: row.lower_key,
            partitionHash: row.partition_hash,
            payload: row.payload,
          },
        });
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return found;
  };

  /**
   * Makes the scope's row a head naming `epoch`, with `set` columns, and in
   * the same transaction writes `rows` and deletes `remove`: a publication.
   */
  const publishHead = async (
    scopeKey: string,
    input: {
      readonly epoch: string;
      readonly generation: number;
      readonly catalogHash: string;
      readonly write?: readonly ReleaseCatalogPartitionRowFixture[];
      readonly remove?: readonly {
        readonly epoch: string;
        readonly lowerKey: string;
      }[];
    },
  ) => {
    await db.transaction(async (tx) => {
      const current = await tx.findOne("release_catalogs", {
        scope_key: scopeKey,
      });
      if (current === null)
        throw new Error(`No release catalog for ${scopeKey}`);
      const keyOf = (key: {
        readonly epoch: string;
        readonly lowerKey: string;
      }) => JSON.stringify([key.epoch, key.lowerKey]);
      const written = new Set((input.write ?? []).map(keyOf));
      for (const key of input.remove ?? []) {
        if (written.has(keyOf(key))) continue;
        const row = await tx.findOne("release_catalog_partitions", {
          epoch: key.epoch,
          lower_key: key.lowerKey,
          scope_key: scopeKey,
        });
        if (row !== null) await tx.delete("release_catalog_partitions", row);
      }
      for (const row of input.write ?? []) {
        const values = {
          byte_size: row.partition.byteSize,
          generation: row.generation,
          partition_hash: row.partition.partitionHash,
          payload: row.partition.payload,
        };
        // A row rewritten in place keeps its key.
        const existing = await tx.findOne("release_catalog_partitions", {
          epoch: row.epoch,
          lower_key: row.lowerKey,
          scope_key: scopeKey,
        });
        if (existing === null) {
          tx.create("release_catalog_partitions", {
            ...values,
            epoch: row.epoch,
            lower_key: row.lowerKey,
            scope_key: scopeKey,
          });
        } else {
          tx.update("release_catalog_partitions", existing, values);
        }
      }
      const payload = releaseCatalogHeadPayload(input.epoch);
      tx.update("release_catalogs", current, {
        byte_size: bytes(payload),
        catalog_hash: input.catalogHash,
        generation: input.generation,
        payload,
      });
    });
  };

  return {
    readRow,
    rows,
    writeRows,
    deleteRows,
    publishHead,

    /**
     * Converts the scope's compact catalog in place: rows under `epoch`
     * stamped at the stored generation, then the head, keeping every
     * identity column. Returns the rows and the row it replaced.
     */
    async partition(
      scopeKey: string,
      { epoch = crypto.randomUUID() }: { readonly epoch?: string } = {},
    ) {
      const compact = await readRow(scopeKey);
      const tiling = await tileCompiledReleaseCatalog(
        JSON.parse(compact.payload) as CompiledReleaseCatalog,
      );
      if (tiling === null) {
        throw new Error(`${scopeKey}'s catalog doesn't fit partition keys`);
      }
      const partitionRows = tiling.map((partition) => ({
        epoch,
        generation: compact.generation,
        lowerKey: partition.lowerKey,
        partition,
      }));
      await writeRows(scopeKey, partitionRows);
      await publishHead(scopeKey, {
        catalogHash: compact.catalog_hash,
        epoch,
        generation: compact.generation,
      });
      return { compact, epoch, rows: partitionRows };
    },

    /** Replaces the scope's row with a compact catalog: a released writer's head→compact. */
    async publishCompact(
      scopeKey: string,
      input: {
        readonly payload: string;
        readonly generation: number;
        readonly catalogHash: string;
      },
    ) {
      await db.transaction(async (tx) => {
        const current = await tx.findOne("release_catalogs", {
          scope_key: scopeKey,
        });
        if (current === null) {
          throw new Error(`No release catalog for ${scopeKey}`);
        }
        tx.update("release_catalogs", current, {
          byte_size: bytes(input.payload),
          catalog_hash: input.catalogHash,
          generation: input.generation,
          payload: input.payload,
        });
      });
    },
  };
};

export type ReleaseCatalogPartitionFixture = ReturnType<
  typeof createReleaseCatalogPartitionFixture
>;
