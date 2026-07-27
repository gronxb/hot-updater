export type ProviderMatrixObservation = Readonly<{
  id: string;
  entry: string;
  targets: readonly string[];
  contexts: readonly ["A1", "B", "A2"];
  operations: readonly ["put", "head", "get", "delete"];
  origins: readonly ["A", "B", "A"];
  providerVisible: Readonly<
    Record<string, readonly string[] | boolean | number>
  >;
  cache: Readonly<{
    literal: "allowed";
    tagged: "forbidden";
  }>;
  streamLifetime: "borrowed" | "operation-owned" | "response-owned";
  secretCanaryLeaked: false;
}>;

export const REQUIRED_CONTEXTS = ["A1", "B", "A2"] as const;
export const REQUIRED_OPERATIONS = ["put", "head", "get", "delete"] as const;
export const REQUIRED_ORIGINS = ["A", "B", "A"] as const;
