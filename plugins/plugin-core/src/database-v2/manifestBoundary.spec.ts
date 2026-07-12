import { describe, expect, it } from "vitest";

import {
  DatabaseConnectorErrorV2,
  hashDatabaseManifestTupleV1,
  hashDatabaseScopeV1,
  IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2,
} from "./index";
import type { DatabaseManifestTupleV2 } from "./manifest";

const createValidTuple = (): DatabaseManifestTupleV2 => ({
  ...IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2,
  certification: {
    tier: IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2.certification.tier,
    id: IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2.certification.id,
  },
  runtime: {
    ...IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2.runtime,
    constraints: [
      ...IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2.runtime.constraints,
    ],
  },
});

type ValidFutureTupleCase = {
  readonly label: string;
  readonly mutate: (tuple: DatabaseManifestTupleV2) => void;
};

const validFutureTupleCases: readonly ValidFutureTupleCase[] = [
  {
    label: "Kysely PostgreSQL on Node",
    mutate: (tuple) => {
      Reflect.set(tuple, "supportTier", "certified");
      Reflect.set(tuple.adapter, "family", "kysely");
      Reflect.set(tuple.target, "product", "postgresql");
      Reflect.set(tuple.target, "transport", "tcp");
      Reflect.set(tuple.runtime, "family", "node");
      Reflect.set(tuple.runtime, "version", "24");
      Reflect.set(tuple.runtime, "constraints", []);
      Reflect.set(tuple.certification, "tier", "certified");
      Reflect.set(tuple.capabilities.commit, "primitive", "transaction");
      Reflect.set(tuple.capabilities, "cursor", "offset");
      Reflect.set(tuple.capabilities, "events", "idempotent-append");
      Reflect.set(tuple.capabilities, "management", "separate");
      Reflect.set(tuple.lifecycle, "clientOwnership", "borrowed");
    },
  },
  {
    label: "Prisma D1 on workerd",
    mutate: (tuple) => {
      Reflect.set(tuple, "supportTier", "preview");
      Reflect.set(tuple.adapter, "family", "prisma");
      Reflect.set(tuple.target, "product", "d1");
      Reflect.set(tuple.target, "transport", "binding");
      Reflect.set(tuple.runtime, "family", "workerd");
      Reflect.set(tuple.runtime, "version", "2026-07");
      Reflect.set(tuple.runtime, "constraints", ["edge", "isolated"]);
      Reflect.set(tuple.capabilities.commit, "guarantee", "unsupported");
      Reflect.set(tuple.capabilities.commit, "primitive", "batch");
      Reflect.set(tuple.capabilities, "cursor", "none");
      Reflect.set(tuple.lifecycle, "clientOwnership", "owned");
    },
  },
];

const hashUnknownTuple = (tuple: unknown) =>
  Reflect.apply(hashDatabaseManifestTupleV1, undefined, [tuple]);

describe("DatabaseManifestTupleV2 canonical boundary", () => {
  it("keeps the public scope digest exact when Number.prototype.toString is hostile", async () => {
    // Given a public consumer provider that installs a hostile formatter
    const originalToString = Number.prototype.toString;
    let hookCalls = 0;

    // When provider-time mutation precedes public-boundary formatting
    let digest: string;
    try {
      digest = await hashDatabaseScopeV1(
        {
          principalId: "public-principal",
          tenantId: "public-tenant",
        },
        async () => {
          Object.defineProperty(Number.prototype, "toString", {
            configurable: true,
            writable: true,
            value: function (radix?: number) {
              if (radix === 16) {
                hookCalls += 1;
                return "number-hook";
              }
              return Reflect.apply(originalToString, this, [radix]);
            },
          });
          return new Uint8Array(32);
        },
      );
    } finally {
      Object.defineProperty(Number.prototype, "toString", {
        configurable: true,
        writable: true,
        value: originalToString,
      });
    }

    // Then the public contract remains one exact lowercase SHA-256 digest
    expect(digest).toBe(`sha256:${"00".repeat(32)}`);
    expect(hookCalls).toBe(0);
  });

  it("keeps the public scope digest exact when String.prototype.padStart is hostile", async () => {
    // Given a public consumer provider that installs a hostile formatter
    const originalPadStart = String.prototype.padStart;
    let hookCalls = 0;

    // When provider-time mutation precedes public-boundary formatting
    let digest: string;
    try {
      digest = await hashDatabaseScopeV1(
        {
          principalId: "public-principal",
          tenantId: "public-tenant",
        },
        async () => {
          Object.defineProperty(String.prototype, "padStart", {
            configurable: true,
            writable: true,
            value: function (length: number, fill?: string) {
              if (length === 2 && fill === "0") {
                hookCalls += 1;
                return "pad-hook";
              }
              return Reflect.apply(originalPadStart, this, [length, fill]);
            },
          });
          return new Uint8Array(32);
        },
      );
    } finally {
      Object.defineProperty(String.prototype, "padStart", {
        configurable: true,
        writable: true,
        value: originalPadStart,
      });
    }

    // Then the public contract remains one exact lowercase SHA-256 digest
    expect(digest).toBe(`sha256:${"00".repeat(32)}`);
    expect(hookCalls).toBe(0);
  });

  it.each(validFutureTupleCases)(
    "accepts valid future literal tuple $label without inferring combinations",
    async ({ mutate }) => {
      // Given a future tuple composed only from frozen public literal domains
      const tuple = createValidTuple();
      mutate(tuple);

      // When it is hashed with a deterministic injected provider
      const digest = await hashDatabaseManifestTupleV1(tuple, () =>
        new Uint8Array(32).fill(0xab),
      );

      // Then validation accepts the grammar without certifying the combination
      expect(digest).toBe(`sha256:${"ab".repeat(32)}`);
    },
  );

  it.each([
    {
      label: "symbol key",
      create: () => ({ ...createValidTuple(), [Symbol("hidden")]: true }),
    },
    {
      label: "inherited prototype",
      create: () => Object.create(createValidTuple()),
    },
    {
      label: "accessor property",
      create: () =>
        Object.defineProperty(createValidTuple(), "kind", {
          enumerable: true,
          get: () => "hot-updater.database-connector",
        }),
    },
  ])("preserves canonicalization errors for a $label", ({ create }) => {
    // Given a structurally unsafe value rejected by canonical snapshotting
    const tuple = create();

    // When and Then the canonical boundary remains distinct from domain errors
    expect(() => hashUnknownTuple(tuple)).toThrowError(
      expect.objectContaining({
        name: "DatabaseConnectorErrorV2",
        code: "CANONICALIZATION_FAILED",
      }),
    );
  });

  it("preserves the cause of hostile descriptor inspection", () => {
    // Given descriptor inspection that throws an attacker-controlled marker
    const marker = new RangeError("manifest descriptor marker");
    const tuple = new Proxy(createValidTuple(), {
      getOwnPropertyDescriptor: () => {
        throw marker;
      },
    });

    // When the public boundary snapshots the tuple
    const result = () => hashUnknownTuple(tuple);

    // Then the canonical error remains synchronous and carries the cause
    expect(result).toThrowError(DatabaseConnectorErrorV2);
    expect(result).toThrowError(
      expect.objectContaining({
        code: "CANONICALIZATION_FAILED",
        cause: marker,
      }),
    );
  });
});
