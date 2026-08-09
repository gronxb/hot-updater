export const DYNAMODB_MAX_BUNDLES = 1_000;
export const DYNAMODB_MAX_PATCHES = 1_000;
export const DYNAMODB_MAX_RELATIONSHIPS_PER_BUNDLE = 24;
export const DYNAMODB_MAX_METADATA_ITEM_BYTES = 8 * 1_024;

export class DynamoDBMetadataItemSizeError extends Error {
  readonly name = "DynamoDBMetadataItemSizeError";

  constructor(readonly byteLength: number) {
    super(
      `DynamoDB metadata item is ${byteLength} bytes; maximum is ${DYNAMODB_MAX_METADATA_ITEM_BYTES}`,
    );
  }
}

export const boundedDynamoDBMetadataItem = <TItem extends object>(
  item: TItem,
): TItem => {
  const byteLength = new TextEncoder().encode(JSON.stringify(item)).byteLength;
  if (byteLength > DYNAMODB_MAX_METADATA_ITEM_BYTES) {
    throw new DynamoDBMetadataItemSizeError(byteLength);
  }
  return item;
};
