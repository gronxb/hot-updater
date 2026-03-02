import type { IncrementalOptions, IncrementalPatchStrategy } from "./types";

export type IncrementalConfigInput = boolean | IncrementalOptions | undefined;

export interface ResolvedIncrementalConfig {
  enabled: boolean;
  strategy: IncrementalPatchStrategy;
}

export function resolveIncrementalConfig(
  input: IncrementalConfigInput,
): ResolvedIncrementalConfig {
  if (typeof input === "boolean") {
    return {
      enabled: input,
      strategy: "manifest",
    };
  }

  if (!input) {
    return {
      enabled: false,
      strategy: "manifest",
    };
  }

  return {
    enabled: input.enable ?? true,
    strategy: input.strategy ?? "manifest",
  };
}
