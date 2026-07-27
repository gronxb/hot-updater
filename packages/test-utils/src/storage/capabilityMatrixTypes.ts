import type { ConfigTarget } from "@hot-updater/core/config";

export type StorageCapability = "supported" | "unsupported";
export type StorageOwnership =
  | "borrowed-direct"
  | "owned-factory"
  | "remote-mount";
export type StorageRuntimeObservation =
  | "binding"
  | "bucket"
  | "client"
  | "context"
  | "credential"
  | "endpoint"
  | "header"
  | "stream";

export type StorageProviderMatrixCell = Readonly<{
  id: string;
  entry: string;
  entryTarget: "neutral" | ConfigTarget;
  target: ConfigTarget;
  acceptedTargets: readonly ConfigTarget[];
  protocol: string;
  contractVersion: 2;
  operations: Readonly<{
    put: true;
    head: true;
    get: true;
    delete: true;
  }>;
  createOnly: boolean;
  range: boolean;
  delivery: StorageCapability;
  list: StorageCapability;
  ownership: StorageOwnership;
  runtime: Readonly<{
    observations: readonly StorageRuntimeObservation[];
    literalCache: "allowed";
    taggedCache: "forbidden";
    streamLifetime: "borrowed" | "operation-owned" | "response-owned";
  }>;
}>;

export type StorageProviderMatrixCellInput = Readonly<
  Omit<
    StorageProviderMatrixCell,
    "contractVersion" | "operations" | "runtime"
  > & {
    readonly observations: readonly StorageRuntimeObservation[];
    readonly streamLifetime: StorageProviderMatrixCell["runtime"]["streamLifetime"];
  }
>;
