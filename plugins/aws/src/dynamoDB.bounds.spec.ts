import { describe, expect, it } from "vitest";

import {
  boundedDynamoDBMetadataItem,
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
});
