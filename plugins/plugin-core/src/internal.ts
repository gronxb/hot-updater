export {
  type AdapterResource,
  adapterResourceOf,
  withAdapterResource,
} from "./adapterResource";
export { DatabaseRowReferencedError } from "./databaseErrors";
export { isDatabaseJsonObject } from "./databaseJsonValue";
export type * from "./types/internal";

export * from "./database";

// Hot Updater's own packages: the schema shapes the server resolves, and the
// brand that tells its official plugins apart.
export type {
  AggregateShape,
  DerivedShape,
  ModelShape,
  SchemaShape,
  TableShape,
} from "./serverPlugin/definitions";
export {
  checkReservedId,
  isOfficialPlugin,
  markOfficial,
} from "./serverPlugin/official";

// The conditional types `definePlugin` and `defineTable` check their input
// with, which authors never name, and the test Hot Updater's own routes use
// to answer 503 while the database is busy.
export type { CliFor, InstanceFor } from "./serverPlugin/definePlugin";
export type { CheckIndex } from "./serverPlugin/schema";
export { isDatabaseBusyError } from "./serverPlugin/busy";
