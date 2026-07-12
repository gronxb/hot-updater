import type { DatabaseConnectorManifestV2 } from "./manifest";

const runtime = Object.freeze({
  family: "javascript",
  version: "es2022",
  constraints: Object.freeze([
    "non-durable",
    "process-local",
    "sha256-required",
  ]),
});

const capabilities = Object.freeze({
  commit: Object.freeze({
    guarantee: "atomic",
    primitive: "memory-atomic",
    interactiveTransaction: false,
  }),
  cursor: "opaque-keyset",
  events: "none",
  management: "none",
});

export const IN_MEMORY_DATABASE_CONNECTOR_MANIFEST_V2 = Object.freeze({
  kind: "hot-updater.database-connector",
  apiVersion: 2,
  supportTier: "experimental-reference",
  connector: Object.freeze({
    name: "hot-updater-memory-reference",
    version: "1",
  }),
  adapter: Object.freeze({ family: "native", version: "1" }),
  driver: Object.freeze({ name: "memory", version: "1" }),
  target: Object.freeze({ product: "memory", transport: "process-local" }),
  runtime,
  certification: Object.freeze({
    tier: "reference",
    id: "hot-updater.database.memory.reference-v1",
    tupleDigest:
      "sha256:5d6872bfae8e5627b47a6bf90bba7729f93b4adc336cb50d8c36c2ce69137057",
  }),
  schema: Object.freeze({
    readable: "reference-memory-v1",
    writable: "reference-memory-v1",
  }),
  capabilities,
  lifecycle: Object.freeze({ clientOwnership: "internal" }),
} satisfies DatabaseConnectorManifestV2);
