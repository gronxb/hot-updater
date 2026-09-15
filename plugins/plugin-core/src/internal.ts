export {
  createDatabasePluginAdapter,
  DatabaseRowReferencedError,
  type DatabasePluginAdapter,
} from "./createDatabasePlugin";
export { databaseFields } from "./types/databaseFields";
export type * from "./types/internal";

export {
  latestInsightsWhere,
  latestInsightsCountGroups,
} from "./insightsLatestQueries";
export {
  insightsHourlyBucketKey,
  insightsLifetimeMarkerKey,
  insightsReleaseKey,
  prepareInsightsEvent,
  recordProjectedInsightsEvent,
  reduceInsightsProjection,
} from "./insightsProjection";
export type {
  InsightsCurrentDelta,
  InsightsLifetimeKey,
  InsightsRecordContext,
  InsightsProjectionBackend,
  PreparedInsightsEvent,
} from "./insightsProjection";
export { createMemoryInsightsProjection } from "./insightsMemoryProjection";
