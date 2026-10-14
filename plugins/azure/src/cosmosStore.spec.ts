import type { StoredRow } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { COSMOS_LIMITS, toItem } from "./cosmosStore";

/** Cosmos DB's cap on an item and on a transactional batch request. */
const COSMOS_MAX_BYTES = 2 * 1024 * 1024;

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** The bytes plugin-core's KV kit measures for a put. */
const measured = (pk: string, sk: string, row: StoredRow) =>
  new TextEncoder().encode(pk + sk + JSON.stringify(row)).length;

/** A row whose map value holds only characters JSON escapes, padded to `size` measured bytes. */
const worstRow = (pk: string, sk: string, size: number, char: string) => {
  const empty = measured(pk, sk, { _v: 1, value: { text: "" } });
  const escaped = JSON.stringify(char).length - 2;
  return {
    _v: 1,
    value: { text: char.repeat(Math.floor((size - empty) / escaped)) },
  } as StoredRow;
};

describe("COSMOS_LIMITS", () => {
  it.each(['"', "\\"])(
    "keeps an item of escaped %s within Cosmos DB's 2 MB",
    (char) => {
      const pk = "remote_config";
      const sk = "a".repeat(200);
      const row = worstRow(pk, sk, COSMOS_LIMITS.itemBytes, char);
      expect(measured(pk, sk, row)).toBeLessThanOrEqual(
        COSMOS_LIMITS.itemBytes,
      );

      expect(bytes(toItem({ pk, sk }, row, Date.now()))).toBeLessThan(
        COSMOS_MAX_BYTES,
      );
    },
  );

  it("keeps a full batch of escaped items within Cosmos DB's 2 MB request", () => {
    const items = Array.from({ length: COSMOS_LIMITS.items }, (_, index) => {
      const pk = `table_${index}`;
      const sk = `key_${index}`;
      const row = worstRow(
        pk,
        sk,
        Math.floor(COSMOS_LIMITS.bytes / COSMOS_LIMITS.items),
        '"',
      );
      return {
        operationType: "Upsert",
        ifMatch: '"00000000-0000-0000-0000-000000000000"',
        resourceBody: toItem({ pk, sk }, row, Date.now()),
      };
    });

    expect(bytes(items)).toBeLessThan(COSMOS_MAX_BYTES);
  });
});
