import type { Document } from "mongodb";

export const MONGO_CHANNEL_ID_PIPELINE: Document[] = [
  {
    $project: {
      channelId: { $ifNull: ["$channel_id", "$channel"] },
    },
  },
  {
    $match: {
      channelId: { $type: "string", $ne: "" },
    },
  },
  { $group: { _id: "$channelId" } },
];

export interface MongoMigrationBackend {
  ensureCollections(): Promise<void>;
  findChannelIds(): Promise<readonly string[]>;
  upsertChannel(id: string): Promise<void>;
  normalizeLegacyBundles(): Promise<void>;
  ensureIndexes(): Promise<void>;
  updateVersion(): Promise<void>;
}

export const executeMongoMigration = async ({
  backend,
  updateSettings,
}: {
  readonly backend: MongoMigrationBackend;
  readonly updateSettings: boolean;
}): Promise<void> => {
  await backend.ensureCollections();
  const channelIds = await backend.findChannelIds();
  for (const id of channelIds) {
    await backend.upsertChannel(id);
  }
  await backend.normalizeLegacyBundles();
  await backend.ensureIndexes();
  if (updateSettings) await backend.updateVersion();
};
