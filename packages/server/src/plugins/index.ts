/**
 * The plugin authoring API. Built-in and third-party plugins declare their
 * tables and aggregates here and receive a typed database handle in `init`.
 */
export {
  definePlugin,
  type AnyHotUpdaterPlugin,
  type ClientAuth,
  type CoreReader,
  type HotUpdaterPlugin,
  type InstanceFor,
  type PluginApis,
  type PluginContext,
  type PluginEndpoint,
  type PluginEndpointMethod,
  type PluginInstance,
  type PluginProvides,
} from "./definePlugin";
export {
  defineAggregate,
  defineTable,
  type AggregateDefinition,
  type DerivedDefinition,
  type FieldDefinition,
  type FieldReference,
  type FieldType,
  type IndexDefinition,
  type ModuleSchema,
  type ReferenceAction,
  type TableDefinition,
} from "../database/schema";
export type {
  AggregateChanges,
  AggregateIdentity,
  AggregateRow,
  CreateRow,
  HotUpdaterDatabase,
  HotUpdaterTransaction,
  Lookup,
  ReadOptions,
  TableRow,
  UpdateSet,
} from "../database/database";
export type { Page } from "../database/engineReads";
export {
  DatabaseAmbiguousCommitError,
  DatabaseConflictError,
  DatabaseConstraintError,
  DatabaseTransactionError,
  type ConstraintReason,
} from "../database/errors";
export { DatabaseQueryError } from "../database/engineReads";
export { DatabaseCursorError } from "../database/cursor";
export { HotUpdaterConfigError } from "../assembly/assemblePlugins";
