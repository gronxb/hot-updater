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
