import { describe, expect, it } from "vitest";

import {
  DatabaseConnectorErrorV2,
  hashDatabaseManifestTupleV1,
  IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2,
} from "./index";
import type { DatabaseManifestTupleV2 } from "./manifest";

const referenceTupleWithReorderedConstraints = {
  kind: "hot-updater.database-connector",
  apiVersion: 2,
  supportTier: "experimental-reference",
  connector: { name: "hot-updater-memory-reference", version: "1" },
  adapter: { family: "native", version: "1" },
  driver: { name: "memory", version: "1" },
  target: { product: "memory", transport: "process-local" },
  runtime: {
    family: "javascript",
    version: "es2022",
    constraints: ["sha256-required", "non-durable", "process-local"],
  },
  certification: {
    tier: "reference",
    id: "hot-updater.database.memory.reference-v1",
  },
  schema: {
    readable: "reference-memory-v1",
    writable: "reference-memory-v1",
  },
  capabilities: {
    commit: {
      guarantee: "atomic",
      primitive: "memory-atomic",
      interactiveTransaction: false,
    },
    cursor: "opaque-keyset",
    events: "none",
    management: "none",
  },
  lifecycle: { clientOwnership: "internal" },
} satisfies DatabaseManifestTupleV2;

describe("IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2", () => {
  it("publishes only the truthful process-local reference tuple", () => {
    // Given the exported fixed reference manifest
    // When its complete value is observed
    // Then every identity and capability field matches the literal contract
    expect(IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2).toEqual({
      ...referenceTupleWithReorderedConstraints,
      runtime: {
        ...referenceTupleWithReorderedConstraints.runtime,
        constraints: ["non-durable", "process-local", "sha256-required"],
      },
      certification: {
        ...referenceTupleWithReorderedConstraints.certification,
        tupleDigest:
          "sha256:5d6872bfae8e5627b47a6bf90bba7729f93b4adc336cb50d8c36c2ce69137057",
      },
    });
  });

  it("is deeply frozen against caller mutation", () => {
    // Given the public manifest and nested values
    const manifest = IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2;

    // When caller mutation is attempted without bypassing the type system
    const rootMutation = Reflect.set(manifest, "supportTier", "certified");
    const nestedMutation = Reflect.set(manifest.runtime, "version", "esnext");
    const arrayMutation = Reflect.set(
      manifest.runtime.constraints,
      0,
      "durable",
    );

    // Then every mutation is refused and the fixed value remains unchanged
    expect(rootMutation).toBe(false);
    expect(nestedMutation).toBe(false);
    expect(arrayMutation).toBe(false);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.runtime)).toBe(true);
    expect(Object.isFrozen(manifest.runtime.constraints)).toBe(true);
    expect(manifest.supportTier).toBe("experimental-reference");
  });

  it("recomputes its literal tuple digest independent of constraint order", async () => {
    // Given the complete tuple with its unordered constraint set reversed
    // When the manifest-domain digest is recomputed
    const digest = await hashDatabaseManifestTupleV1(
      referenceTupleWithReorderedConstraints,
    );

    // Then it matches the checked-in reference identity
    expect(digest).toBe(
      "sha256:5d6872bfae8e5627b47a6bf90bba7729f93b4adc336cb50d8c36c2ce69137057",
    );
    expect(digest).toBe(
      IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2.certification.tupleDigest,
    );
  });

  it("hashes one root descriptor snapshot without live Proxy reads", async () => {
    // Given a manifest Proxy that mutates nested state on any live read
    let getCalls = 0;
    const mutableTuple = {
      ...referenceTupleWithReorderedConstraints,
      connector: { ...referenceTupleWithReorderedConstraints.connector },
    } satisfies DatabaseManifestTupleV2;
    const tuple = new Proxy(mutableTuple, {
      get: () => {
        getCalls += 1;
        Reflect.set(mutableTuple.connector, "name", "mutated-after-validation");
        throw new RangeError("manifest live read");
      },
    });

    // When the public identity helper hashes the tuple
    const digest = await hashDatabaseManifestTupleV1(tuple);

    // Then identity comes from the validated snapshot and never invokes get
    expect(digest).toBe(
      "sha256:5d6872bfae8e5627b47a6bf90bba7729f93b4adc336cb50d8c36c2ce69137057",
    );
    expect(getCalls).toBe(0);
    expect(mutableTuple.connector.name).toBe(
      referenceTupleWithReorderedConstraints.connector.name,
    );
  });

  it("hashes nested descriptor snapshots without live Proxy reads", async () => {
    // Given nested object and array Proxies whose get traps throw
    let connectorGets = 0;
    let constraintGets = 0;
    const connector = new Proxy(
      referenceTupleWithReorderedConstraints.connector,
      {
        get: () => {
          connectorGets += 1;
          throw new RangeError("nested manifest live read");
        },
      },
    );
    const constraints = new Proxy(
      [...referenceTupleWithReorderedConstraints.runtime.constraints],
      {
        get: () => {
          constraintGets += 1;
          throw new RangeError("constraint array live read");
        },
      },
    );
    const tuple = {
      ...referenceTupleWithReorderedConstraints,
      connector,
      runtime: {
        ...referenceTupleWithReorderedConstraints.runtime,
        constraints,
      },
    } satisfies DatabaseManifestTupleV2;

    // When the public identity helper hashes the tuple
    const digest = await hashDatabaseManifestTupleV1(tuple);

    // Then neither nested Proxy is read live and the frozen vector is stable
    expect(digest).toBe(
      "sha256:5d6872bfae8e5627b47a6bf90bba7729f93b4adc336cb50d8c36c2ce69137057",
    );
    expect(connectorGets).toBe(0);
    expect(constraintGets).toBe(0);
  });

  it("reports hostile descriptor inspection through the typed error API", async () => {
    // Given a manifest Proxy that refuses descriptor inspection
    const tuple = new Proxy(referenceTupleWithReorderedConstraints, {
      getOwnPropertyDescriptor: () => {
        throw new RangeError("manifest descriptor inspection failed");
      },
    });

    // When the tuple crosses the public identity boundary
    const hashTuple = () => hashDatabaseManifestTupleV1(tuple);

    // Then the stable typed code and original inspection cause are preserved
    expect(hashTuple).toThrowError(DatabaseConnectorErrorV2);
    expect(hashTuple).toThrowError(
      expect.objectContaining({
        name: "DatabaseConnectorErrorV2",
        code: "CANONICALIZATION_FAILED",
        cause: expect.any(RangeError),
      }),
    );
  });
});
