import { describe, expect, it } from "vitest";

import { snapshotDatabaseChangeSetV2 } from "./changeSetValidation";
import { hashDatabaseScopeV1 } from "./databaseIdentity";
import { parseInMemoryPageQueryV2 } from "./inMemoryQuery";
import { validateCommitReceiptV2 } from "./receiptValidation";
import {
  CHANGE_SET_IDS,
  createRuntimeChangeSet,
} from "./sessionRuntime.testFixtures";

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null
    ? Reflect.get(error, "code")
    : undefined;

const errorCause = (error: unknown): unknown =>
  typeof error === "object" && error !== null
    ? Reflect.get(error, "cause")
    : undefined;

const callSnapshotChangeSet = (value: unknown): unknown =>
  Reflect.apply(snapshotDatabaseChangeSetV2, undefined, [value]);

const callParsePageQuery = (value: unknown): unknown =>
  Reflect.apply(parseInMemoryPageQueryV2, undefined, [value]);

const expectedReceipt = {
  changeSetId: CHANGE_SET_IDS.first,
  scopeId: "sha256:scope",
  canonicalPayloadHash: "sha256:payload",
} as const;

describe("database-v2 hostile shape matrix", () => {
  it("normalizes accessor, hidden, symbol, prototype, and proxy inputs", () => {
    // Given every forbidden object inspection class
    let getterCalls = 0;
    class InheritedShape {
      readonly value = true;
    }
    const factories: readonly (() => unknown)[] = [
      () =>
        Object.defineProperty({}, "value", {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return true;
          },
        }),
      () => Object.defineProperty({}, "hidden", { value: true }),
      () => ({ [Symbol("hidden")]: true }),
      () => new InheritedShape(),
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf: () => {
              throw new RangeError("prototype trap marker");
            },
          },
        ),
    ];

    // When each shape crosses all three untyped runtime boundaries
    for (const factory of factories) {
      expect(() => callSnapshotChangeSet(factory())).toThrowError(
        expect.objectContaining({ code: "INVALID_CHANGE_SET" }),
      );
      expect(() => callParsePageQuery(factory())).toThrowError(
        expect.objectContaining({ code: "INVALID_CURSOR" }),
      );
      expect(() =>
        validateCommitReceiptV2(
          factory(),
          expectedReceipt,
          createRuntimeChangeSet(CHANGE_SET_IDS.first),
        ),
      ).toThrowError(
        expect.objectContaining({ code: "CONNECTOR_PROTOCOL_VIOLATION" }),
      );
    }

    // Then no accessor executes and no raw RangeError escapes
    expect(getterCalls).toBe(0);
  });
});

describe("hashDatabaseScopeV1 hostile shape matrix", () => {
  it("rejects proxy, prototype, symbol, hidden, and non-string identifiers", async () => {
    // Given malformed identity containers across orthogonal shape classes
    class InheritedScope {
      readonly tenantId = "tenant-a";
      readonly principalId = "principal-a";
    }
    const hiddenTenant = { tenantId: "tenant-a", principalId: "principal-a" };
    Object.defineProperty(hiddenTenant, "tenantId", { enumerable: false });
    const cases: readonly unknown[] = [
      new InheritedScope(),
      { tenantId: "tenant-a", principalId: "principal-a", [Symbol()]: true },
      hiddenTenant,
      { tenantId: 7, principalId: "principal-a" },
      new Proxy(
        { tenantId: "tenant-a", principalId: "principal-a" },
        {
          ownKeys: () => {
            throw new RangeError("scope ownKeys marker");
          },
        },
      ),
    ];

    // When each scope reaches the versioned hash boundary
    const results = await Promise.all(
      cases.map(
        async (scope) =>
          await Reflect.apply(hashDatabaseScopeV1, undefined, [scope]).then(
            () => ({ kind: "fulfilled" }) as const,
            (error: unknown) => ({ error, kind: "rejected" }) as const,
          ),
      ),
    );

    // Then every failure is stable and strips hostile causes
    for (const result of results) {
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(errorCode(result.error)).toBe("CANONICALIZATION_FAILED");
        expect(errorCause(result.error)).toBeUndefined();
      }
    }
  });
});
