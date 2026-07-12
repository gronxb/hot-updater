import { describe, expect, it } from "vitest";

import { hashDatabaseManifestTupleV1 } from "./index";
import type { DatabaseManifestTupleV2 } from "./manifest";

const createValidTuple = (): DatabaseManifestTupleV2 => ({
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
});

type MalformedTupleCase = {
  readonly label: string;
  readonly mutate: (tuple: DatabaseManifestTupleV2) => void;
};

const malformedTupleCases: readonly MalformedTupleCase[] = [
  {
    label: "wrong kind",
    mutate: (tuple) => void Reflect.set(tuple, "kind", "database"),
  },
  {
    label: "wrong API version",
    mutate: (tuple) => void Reflect.set(tuple, "apiVersion", 3),
  },
  {
    label: "unknown support tier",
    mutate: (tuple) => void Reflect.set(tuple, "supportTier", "stable"),
  },
  {
    label: "empty connector name",
    mutate: (tuple) => void Reflect.set(tuple.connector, "name", " "),
  },
  {
    label: "non-string connector version",
    mutate: (tuple) => void Reflect.set(tuple.connector, "version", 1),
  },
  {
    label: "unknown adapter family",
    mutate: (tuple) => void Reflect.set(tuple.adapter, "family", "orm"),
  },
  {
    label: "empty driver name",
    mutate: (tuple) => void Reflect.set(tuple.driver, "name", ""),
  },
  {
    label: "unknown target product",
    mutate: (tuple) => void Reflect.set(tuple.target, "product", "oracle"),
  },
  {
    label: "empty transport",
    mutate: (tuple) => void Reflect.set(tuple.target, "transport", ""),
  },
  {
    label: "unknown runtime family",
    mutate: (tuple) => void Reflect.set(tuple.runtime, "family", "browser"),
  },
  {
    label: "non-array constraints",
    mutate: (tuple) => void Reflect.set(tuple.runtime, "constraints", "local"),
  },
  {
    label: "empty constraint",
    mutate: (tuple) => void Reflect.set(tuple.runtime, "constraints", [""]),
  },
  {
    label: "duplicate constraint",
    mutate: (tuple) =>
      void Reflect.set(tuple.runtime, "constraints", ["local", "local"]),
  },
  {
    label: "unknown certification tier",
    mutate: (tuple) => void Reflect.set(tuple.certification, "tier", "preview"),
  },
  {
    label: "empty certification ID",
    mutate: (tuple) => void Reflect.set(tuple.certification, "id", ""),
  },
  {
    label: "tuple digest present",
    mutate: (tuple) =>
      void Reflect.set(tuple.certification, "tupleDigest", "sha256:00"),
  },
  {
    label: "empty readable schema",
    mutate: (tuple) => void Reflect.set(tuple.schema, "readable", " "),
  },
  {
    label: "unknown commit guarantee",
    mutate: (tuple) =>
      void Reflect.set(tuple.capabilities.commit, "guarantee", "eventual"),
  },
  {
    label: "unknown commit primitive",
    mutate: (tuple) =>
      void Reflect.set(tuple.capabilities.commit, "primitive", "lock"),
  },
  {
    label: "non-boolean interactive flag",
    mutate: (tuple) =>
      void Reflect.set(tuple.capabilities.commit, "interactiveTransaction", 0),
  },
  {
    label: "unknown cursor capability",
    mutate: (tuple) => void Reflect.set(tuple.capabilities, "cursor", "keyset"),
  },
  {
    label: "unknown events capability",
    mutate: (tuple) => void Reflect.set(tuple.capabilities, "events", "append"),
  },
  {
    label: "unknown management capability",
    mutate: (tuple) =>
      void Reflect.set(tuple.capabilities, "management", "inline"),
  },
  {
    label: "unknown client ownership",
    mutate: (tuple) =>
      void Reflect.set(tuple.lifecycle, "clientOwnership", "shared"),
  },
  {
    label: "missing root key",
    mutate: (tuple) => void Reflect.deleteProperty(tuple, "connector"),
  },
  {
    label: "missing nested key",
    mutate: (tuple) =>
      void Reflect.deleteProperty(tuple.capabilities.commit, "primitive"),
  },
  {
    label: "extra root key",
    mutate: (tuple) => void Reflect.set(tuple, "provider", "memory"),
  },
  {
    label: "extra nested key",
    mutate: (tuple) => void Reflect.set(tuple.runtime, "durable", false),
  },
];

const hashUnknownTuple = (tuple: unknown, digest: () => Uint8Array) =>
  Reflect.apply(hashDatabaseManifestTupleV1, undefined, [tuple, digest]);

describe("DatabaseManifestTupleV2 validation", () => {
  it.each(malformedTupleCases)(
    "rejects $label before invoking the digest provider",
    ({ mutate }) => {
      // Given one detached but domain-invalid manifest tuple
      const tuple = createValidTuple();
      mutate(tuple);
      let digestCalls = 0;

      // When the tuple crosses the public manifest identity boundary
      const hashTuple = () =>
        hashUnknownTuple(tuple, () => {
          digestCalls += 1;
          return new Uint8Array(32);
        });

      // Then a stable typed manifest error wins before hashing
      expect(hashTuple).toThrowError(
        expect.objectContaining({
          name: "DatabaseConnectorErrorV2",
          code: "INVALID_MANIFEST",
        }),
      );
      expect(digestCalls).toBe(0);
    },
  );
});
