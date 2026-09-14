import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ApiKeyRow,
  ReleaseCatalogRow,
  ReleaseRow,
  ReleaseReference,
} from "@hot-updater/plugin-core";
import type { ClientSession, Collection, MongoClient } from "mongodb";

export class MongoAdapterConstraintError extends Error {
  readonly name = "MongoAdapterConstraintError";

  constructor(readonly reason: string) {
    super(`MongoDB adapter constraint failed: ${reason}`);
  }
}

export const WITHOUT_MONGO_ID = { _id: 0 } as const;
export const DELETION_TOKEN_FIELD = "_hot_updater_deletion_token" as const;

export type MongoBundleDocument = BundleRow & {
  readonly [DELETION_TOKEN_FIELD]?: string;
};

export type MongoBundleEventHead = Pick<
  BundleEventRow,
  | "install_id"
  | "id"
  | "received_at_ms"
  | "user_id"
  | "platform"
  | "channel"
  | "type"
  | "from_bundle_id"
  | "to_bundle_id"
>;

export const WITHOUT_INTERNAL_FIELDS = {
  ...WITHOUT_MONGO_ID,
  [DELETION_TOKEN_FIELD]: 0,
} as const;

export const activeBundleFilter = (where: object) => ({
  $and: [where, { [DELETION_TOKEN_FIELD]: { $exists: false } }],
});

export type MongoCollections = {
  readonly bundles: Collection<MongoBundleDocument>;
  readonly bundlePatches: Collection<BundlePatchRow>;
  readonly bundleEvents: Collection<BundleEventRow>;
  readonly bundleEventHeads: Collection<MongoBundleEventHead>;
  readonly insightsInstallStates: Collection<{
    install_id: string;
    revision: number;
    state: string;
  }>;
  readonly insightsLifetimeMarkers: Collection<{
    marker_key: string;
    release_id: string;
    platform: ReleaseReference["platform"];
    channel: string;
    install_id: string;
    metric: "downloaded" | "recovered";
  }>;
  readonly insightsReleaseSummaries: Collection<{
    release_key: string;
    release_id: string;
    platform: ReleaseReference["platform"];
    channel: string;
    active_installations: number;
    pending_installations: number;
    downloaded_installations: number;
    recovered_installations: number;
  }>;
  readonly insightsHourlyActivity: Collection<{
    bucket_key: string;
    release_id: string;
    platform: ReleaseReference["platform"];
    channel: string;
    hour_start_ms: number;
    downloaded_reports: number;
    applied_reports: number;
    recovered_reports: number;
  }>;
  readonly channels: Collection<ChannelRow>;
  readonly apiKeys: Collection<ApiKeyRow>;
  readonly releases: Collection<ReleaseRow>;
  readonly releaseCatalogs: Collection<ReleaseCatalogRow>;
};

export const createMongoCollections = (
  client: MongoClient,
): MongoCollections => {
  const database = client.db();
  return {
    bundles: database.collection<MongoBundleDocument>("bundles"),
    bundlePatches: database.collection<BundlePatchRow>("bundle_patches"),
    bundleEvents: database.collection<BundleEventRow>("bundle_events"),
    bundleEventHeads:
      database.collection<MongoBundleEventHead>("bundle_event_heads"),
    insightsInstallStates: database.collection("insights_install_states"),
    insightsLifetimeMarkers: database.collection("insights_lifetime_markers"),
    insightsReleaseSummaries: database.collection("insights_release_summaries"),
    insightsHourlyActivity: database.collection("insights_hourly_activity"),
    channels: database.collection<ChannelRow>("channels"),
    apiKeys: database.collection<ApiKeyRow>("api_keys"),
    releases: database.collection<ReleaseRow>("releases"),
    releaseCatalogs: database.collection<ReleaseCatalogRow>("release_catalogs"),
  };
};

export const mongoSessionOptions = (session?: ClientSession) =>
  session === undefined ? {} : { session };
