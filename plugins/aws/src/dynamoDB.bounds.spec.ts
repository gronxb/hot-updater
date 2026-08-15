import { describe, expect, it } from "vitest";

import {
  boundedDynamoDBCatalogItem,
  boundedDynamoDBMetadataItem,
  DYNAMODB_MAX_CATALOG_ITEM_BYTES,
  DYNAMODB_MAX_METADATA_ITEM_BYTES,
} from "./dynamoDB";

describe("DynamoDB metadata item bound", () => {
  it("accepts the exact byte limit and rejects limit plus one", () => {
    const emptyBytes = new TextEncoder().encode(
      JSON.stringify({ value: "" }),
    ).byteLength;
    const atLimit = {
      value: "x".repeat(DYNAMODB_MAX_METADATA_ITEM_BYTES - emptyBytes),
    };
    const aboveLimit = { value: `${atLimit.value}x` };

    expect(() => boundedDynamoDBMetadataItem(atLimit)).not.toThrow();
    expect(() => boundedDynamoDBMetadataItem(aboveLimit)).toThrowError(
      expect.objectContaining({ name: "DynamoDBMetadataItemSizeError" }),
    );
  });

  it("allows compiled catalogs up to the DynamoDB item boundary", () => {
    const emptyBytes = new TextEncoder().encode(
      JSON.stringify({ payload: "" }),
    ).byteLength;
    const atLimit = {
      payload: "x".repeat(DYNAMODB_MAX_CATALOG_ITEM_BYTES - emptyBytes),
    };

    expect(() => boundedDynamoDBCatalogItem(atLimit)).not.toThrow();
    expect(() =>
      boundedDynamoDBCatalogItem({ payload: `${atLimit.payload}x` }),
    ).toThrowError(
      expect.objectContaining({ name: "DynamoDBCatalogItemSizeError" }),
    );
  });
});
