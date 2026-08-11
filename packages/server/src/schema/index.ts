import type { HotUpdaterVersionedSchema } from "./types";
import { v0_21_0 } from "./v0_21_0";
import { v0_29_0 } from "./v0_29_0";
import { v0_31_0 } from "./v0_31_0";
import { v0_36_0 } from "./v0_36_0";
import { v0_37_0 } from "./v0_37_0";

export * from "./settings";
export * from "./types";
export * from "./v0_21_0";
export * from "./v0_29_0";
export * from "./v0_31_0";
export * from "./v0_36_0";
export * from "./v0_37_0";

export const hotUpdaterSchemaVersions: readonly HotUpdaterVersionedSchema[] = [
  v0_21_0,
  v0_29_0,
  v0_31_0,
  v0_36_0,
  v0_37_0,
];
