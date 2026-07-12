import type { Sha256Digest } from "./common";

export interface DatabaseConnectorManifestV2 {
  readonly kind: "hot-updater.database-connector";
  readonly apiVersion: 2;
  readonly supportTier: "experimental-reference" | "preview" | "certified";
  readonly connector: { readonly name: string; readonly version: string };
  readonly adapter: {
    readonly family: "kysely" | "drizzle" | "prisma" | "native";
    readonly version: string;
  };
  readonly driver: { readonly name: string; readonly version: string };
  readonly target: {
    readonly product:
      | "memory"
      | "postgresql"
      | "mysql"
      | "sqlite"
      | "d1"
      | "firestore"
      | "mongodb"
      | "s3-object";
    readonly transport: string;
  };
  readonly runtime: {
    readonly family:
      | "javascript"
      | "node"
      | "bun"
      | "deno"
      | "workerd"
      | "react-native";
    readonly version: string;
    readonly constraints: readonly string[];
  };
  readonly certification: {
    readonly tier: "reference" | "certified";
    readonly id: string;
    readonly tupleDigest: string;
  };
  readonly schema: { readonly readable: string; readonly writable: string };
  readonly capabilities: {
    readonly commit: {
      readonly guarantee: "atomic" | "idempotent-best-effort" | "unsupported";
      readonly primitive:
        | "transaction"
        | "batch"
        | "single-statement"
        | "document-transaction"
        | "memory-atomic";
      readonly interactiveTransaction: boolean;
    };
    readonly cursor: "opaque-keyset" | "offset" | "none";
    readonly events: "idempotent-append" | "none";
    readonly management: "separate" | "none";
  };
  readonly lifecycle: {
    readonly clientOwnership: "owned" | "borrowed" | "internal";
  };
}

export type DatabaseManifestTupleV2 = Omit<
  DatabaseConnectorManifestV2,
  "certification"
> & {
  readonly certification: Omit<
    DatabaseConnectorManifestV2["certification"],
    "tupleDigest"
  >;
};

export interface InMemoryDatabaseConnectorV2Options {
  readonly sha256?: Sha256Digest;
}
