import {
  createMapV2,
  getMapValueV2,
  setMapValueV2,
} from "./collectionIntrinsics";
import { DatabaseConnectorErrorV2 } from "./errors";
import type {
  InMemoryCursorRecordV2,
  InMemoryCursorRequestV2,
} from "./inMemoryTypes";

export interface InMemoryCursorScopeV2 {
  readonly tenantId: string;
  readonly principalId: string;
}

export interface InMemoryCursorCreationV2 extends InMemoryCursorScopeV2 {
  readonly queryIdentity: string;
  readonly direction: "after" | "before";
  readonly anchorId: string;
}

export interface InMemoryCursorLookupV2 extends InMemoryCursorScopeV2 {
  readonly queryIdentity: string;
  readonly request: InMemoryCursorRequestV2;
}

const invalidCursor = (): never => {
  throw new DatabaseConnectorErrorV2("INVALID_CURSOR", "invalid cursor");
};

export class InMemoryCursorRegistryV2 {
  private readonly records = createMapV2<string, InMemoryCursorRecordV2>();
  private sequence = 0;

  create(input: InMemoryCursorCreationV2): string {
    this.sequence += 1;
    const token = `memory-cursor-v2:${this.sequence.toString(36)}`;
    setMapValueV2(this.records, token, Object.freeze({ ...input }));
    return token;
  }

  resolve(input: InMemoryCursorLookupV2): InMemoryCursorRecordV2 {
    const record = getMapValueV2(this.records, input.request.token);
    if (
      record === undefined ||
      record.tenantId !== input.tenantId ||
      record.principalId !== input.principalId ||
      record.queryIdentity !== input.queryIdentity ||
      record.direction !== input.request.direction
    ) {
      return invalidCursor();
    }
    return record;
  }
}

export const throwInvalidInMemoryCursorV2 = invalidCursor;
