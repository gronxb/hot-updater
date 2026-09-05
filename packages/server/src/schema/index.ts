import type { HotUpdaterVersionedSchema } from "./types";
import { v1_0_0 } from "./v1_0_0";
import { v1_0_1 } from "./v1_0_1";

export * from "./settings";
export * from "./types";
export * from "./v1_0_0";
export * from "./v1_0_1";

export const hotUpdaterSchemaVersions: readonly HotUpdaterVersionedSchema[] = [
  v1_0_0,
  v1_0_1,
];
