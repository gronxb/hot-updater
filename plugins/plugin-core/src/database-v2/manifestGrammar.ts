export const SUPPORT_TIERS = [
  "experimental-reference",
  "preview",
  "certified",
] as const;
export const ADAPTER_FAMILIES = [
  "kysely",
  "drizzle",
  "prisma",
  "native",
] as const;
export const TARGET_PRODUCTS = [
  "memory",
  "postgresql",
  "mysql",
  "sqlite",
  "d1",
  "firestore",
  "mongodb",
  "s3-object",
] as const;
export const RUNTIME_FAMILIES = [
  "javascript",
  "node",
  "bun",
  "deno",
  "workerd",
  "react-native",
] as const;
export const CERTIFICATION_TIERS = ["reference", "certified"] as const;
export const COMMIT_GUARANTEES = [
  "atomic",
  "idempotent-best-effort",
  "unsupported",
] as const;
export const COMMIT_PRIMITIVES = [
  "transaction",
  "batch",
  "single-statement",
  "document-transaction",
  "memory-atomic",
] as const;
export const CURSOR_CAPABILITIES = ["opaque-keyset", "offset", "none"] as const;
export const EVENT_CAPABILITIES = ["idempotent-append", "none"] as const;
export const MANAGEMENT_CAPABILITIES = ["separate", "none"] as const;
export const CLIENT_OWNERSHIP = ["owned", "borrowed", "internal"] as const;
