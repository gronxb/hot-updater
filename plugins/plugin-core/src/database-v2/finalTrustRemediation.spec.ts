import { describe, expect, it } from "vitest";

import { snapshotDatabaseChangeSetV2 } from "./changeSetValidation";
import { hashDatabaseScopeV1 } from "./databaseIdentity";
import { parseInMemoryPageQueryV2 } from "./inMemoryQuery";
import { validateCommitReceiptV2 } from "./receiptValidation";
import {
  CHANGE_SET_IDS,
  createRuntimeChangeSet,
  createRuntimeScope,
} from "./sessionRuntime.testFixtures";
import { setupRuntimeTestHarness } from "./sessionRuntime.testHarness";
import type { MutableScopeFixture } from "./sessionRuntime.testTypes";

const throwOnThirdOwnKeys = <T extends object>(target: T): T => {
  let ownKeysCalls = 0;
  return new Proxy(target, {
    ownKeys: (proxied) => {
      ownKeysCalls += 1;
      if (ownKeysCalls >= 3) {
        throw new RangeError("hostile ownKeys marker");
      }
      return Reflect.ownKeys(proxied);
    },
  });
};

const expectSyncConnectorCode = (action: () => unknown, code: string): void => {
  expect(action).toThrowError(
    expect.objectContaining({ name: "DatabaseConnectorErrorV2", code }),
  );
};

const callSnapshotChangeSet = (value: unknown): unknown =>
  Reflect.apply(snapshotDatabaseChangeSetV2, undefined, [value]);

const callParsePageQuery = (value: unknown): unknown =>
  Reflect.apply(parseInMemoryPageQueryV2, undefined, [value]);

const errorProperty = (error: unknown, key: string): unknown =>
  typeof error === "object" && error !== null
    ? Reflect.get(error, key)
    : undefined;

describe("database-v2 final trust-boundary remediation", () => {
  const createSubject = setupRuntimeTestHarness();

  it("validates one canonical snapshot instead of re-reading live inputs", async () => {
    // Given hostile inputs that fail only when their live graph is re-read
    const changeSet = throwOnThirdOwnKeys(
      createRuntimeChangeSet(CHANGE_SET_IDS.first),
    );
    const query = throwOnThirdOwnKeys({ limit: 10 });
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    let receiptGets = 0;
    const expectedReceipt = {
      changeSetId: CHANGE_SET_IDS.second,
      scopeId: "sha256:scope",
      canonicalPayloadHash: "sha256:payload",
    };
    const hostileReceipt = new Proxy(
      {
        ...expectedReceipt,
        outcome: "unknown",
        reason: "transport-unknown",
        sessionState: "poisoned",
        retry: "identical-scope-id-and-payload-only",
      },
      {
        get: () => {
          receiptGets += 1;
          throw new RangeError("hostile receipt get marker");
        },
      },
    );

    // When each value crosses its trust boundary
    const committed = await session.applyChangeSet(changeSet);
    const parsed = parseInMemoryPageQueryV2(query);
    const receipt = validateCommitReceiptV2(
      hostileReceipt,
      expectedReceipt,
      createRuntimeChangeSet(CHANGE_SET_IDS.second),
    );

    // Then parsing uses detached data and never invokes live getters
    expect(committed.outcome).toBe("committed");
    expect(parsed.query.limit).toBe(10);
    expect(receipt.outcome).toBe("unknown");
    expect(receiptGets).toBe(0);
    expect(backend.commitAttempts).toBe(1);
  });

  it("normalizes hostile inspection failures at each public boundary", () => {
    // Given proxies whose descriptor inspection throws immediately
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new RangeError("descriptor marker");
        },
        ownKeys: () => ["value"],
      },
    );

    // When and Then each boundary emits its stable connector code
    expectSyncConnectorCode(
      () => callSnapshotChangeSet(hostile),
      "INVALID_CHANGE_SET",
    );
    expectSyncConnectorCode(
      () => callParsePageQuery(hostile),
      "INVALID_CURSOR",
    );
    expectSyncConnectorCode(
      () =>
        validateCommitReceiptV2(
          hostile,
          {
            changeSetId: CHANGE_SET_IDS.first,
            scopeId: "sha256:scope",
            canonicalPayloadHash: "sha256:payload",
          },
          createRuntimeChangeSet(CHANGE_SET_IDS.first),
        ),
      "CONNECTOR_PROTOCOL_VIOLATION",
    );
  });

  it("captures scope identifiers descriptor-safely and excludes context", async () => {
    // Given stable identifiers beside an accessor context
    let contextGets = 0;
    const scope = Object.defineProperty(
      { tenantId: "tenant-a", principalId: "principal-a" },
      "context",
      {
        enumerable: true,
        get: () => {
          contextGets += 1;
          throw new RangeError("context marker");
        },
      },
    );
    let tenantGets = 0;
    const accessorScope = Object.defineProperty(
      {
        tenantId: "placeholder",
        principalId: "principal-a",
        context: undefined,
      },
      "tenantId",
      {
        enumerable: true,
        get: () => {
          tenantGets += 1;
          return "tenant-a";
        },
      },
    );

    // When the scope hash is produced and malformed identifiers are rejected
    const hash = await hashDatabaseScopeV1(scope);
    const accessorResult = hashDatabaseScopeV1(accessorScope);

    // Then context is opaque, identifiers are never invoked, and vectors stay stable
    expect(hash).toBe(
      "sha256:0446f3b9ed66598af4648c82ec418e91e26c4a7d2af8cc19b7894c6e753c22ff",
    );
    await expect(accessorResult).rejects.toMatchObject({
      code: "CANONICALIZATION_FAILED",
    });
    expect(contextGets).toBe(0);
    expect(tenantGets).toBe(0);
  });

  it("does not expose injected digest or backend failures as runtime causes", async () => {
    // Given attacker-controlled failures at the digest and backend seams
    const digestMarker = new Error("injected digest marker");
    const digest = async (): Promise<Uint8Array> => {
      throw digestMarker;
    };
    const digestResultPromise = hashDatabaseScopeV1(
      { tenantId: "tenant-a", principalId: "principal-a" },
      digest,
    ).then(
      () => ({ kind: "fulfilled" }) as const,
      (error: unknown) => ({ error, kind: "rejected" }) as const,
    );
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    const backendMarker = new Error("injected backend marker");
    backend.commit = async () => {
      throw backendMarker;
    };

    // When both failures cross the public runtime membrane
    const digestResult = await digestResultPromise;
    const backendResult = await session
      .applyChangeSet(createRuntimeChangeSet(CHANGE_SET_IDS.first))
      .then(
        () => ({ kind: "fulfilled" }) as const,
        (error: unknown) => ({ error, kind: "rejected" }) as const,
      );

    // Then stable public errors do not expose attacker-controlled causes
    expect(digestResult.kind).toBe("rejected");
    expect(backendResult.kind).toBe("rejected");
    if (digestResult.kind === "rejected") {
      expect(errorProperty(digestResult.error, "code")).toBe(
        "DIGEST_UNAVAILABLE",
      );
      expect(errorProperty(digestResult.error, "cause")).toBeUndefined();
      expect(errorProperty(digestResult.error, "message")).toBe(
        "SHA-256 provider failed",
      );
    }
    if (backendResult.kind === "rejected") {
      expect(errorProperty(backendResult.error, "code")).toBe(
        "CONNECTOR_PROTOCOL_VIOLATION",
      );
      expect(errorProperty(backendResult.error, "cause")).toBeUndefined();
      expect(errorProperty(backendResult.error, "message")).toBe(
        "backend commit did not return a receipt",
      );
    }
    expect(digestMarker.message).toBe("injected digest marker");
    expect(backendMarker.message).toBe("injected backend marker");
  });

  it("normalizes hostile digest result inspection", async () => {
    // Given a digest result whose byte length read throws an injected marker
    const marker = new RangeError("digest result marker");
    const digest = async (): Promise<Uint8Array> =>
      new Proxy(new Uint8Array(32), {
        get: (target, key, receiver) => {
          if (key === "byteLength") {
            throw marker;
          }
          return Reflect.get(target, key, receiver);
        },
      });

    // When the result crosses the digest provider boundary
    const result = await hashDatabaseScopeV1(
      { tenantId: "tenant-a", principalId: "principal-a" },
      digest,
    ).then(
      () => ({ kind: "fulfilled" }) as const,
      (error: unknown) => ({ error, kind: "rejected" }) as const,
    );

    // Then the marker is not exposed through the public error
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(errorProperty(result.error, "code")).toBe("DIGEST_UNAVAILABLE");
      expect(errorProperty(result.error, "message")).toBe(
        "SHA-256 provider returned an unreadable digest",
      );
      expect(errorProperty(result.error, "cause")).toBeUndefined();
    }
  });
});
