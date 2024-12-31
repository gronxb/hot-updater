import type { Bundle } from "@hot-updater/core";

type SnakeCase<S extends string> = S extends `${infer T}${infer U}`
  ? `${T extends Capitalize<T> ? "_" : ""}${Lowercase<T>}${SnakeCase<U>}`
  : S;

// Utility type to recursively map object keys to snake_case
type SnakeKeyObject<T> = T extends Record<string, any>
  ? {
      [K in keyof T as SnakeCase<Extract<K, string>>]: T[K] extends object
        ? SnakeKeyObject<T[K]>
        : T[K];
    }
  : T;

export type BundlesTable = SnakeKeyObject<Bundle>;

export interface Database {
  bundles: BundlesTable;
}
