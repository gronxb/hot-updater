import type { 
  GetBundlesArgs, 
  UpdateInfo 
} from "@hot-updater/core";
import type { 
  DatabaseAdapter, 
  StorageAdapter, 
  StorageUri 
} from "@hot-updater/plugin-core";

export interface AdapterGetUpdateInfoArgs {
  database: DatabaseAdapter;
  storageAdapters: StorageAdapter[];
  args: GetBundlesArgs;
  expiresIn?: number;
}

export async function getUpdateInfo({
  database,
  storageAdapters,
  args,
  expiresIn = 3600 // 1 hour default
}: AdapterGetUpdateInfoArgs): Promise<UpdateInfo | null> {
  // Get update info from database
  const updateInfo = await database.getUpdateInfo(args);
  
  if (!updateInfo || !updateInfo.storageUri) {
    return updateInfo;
  }

  // Find compatible storage adapter and get signed URL
  const signedUrl = await getSignedUrl(
    updateInfo.storageUri,
    storageAdapters,
    expiresIn
  );

  return {
    ...updateInfo,
    storageUri: signedUrl
  };
}

async function getSignedUrl(
  storageUri: StorageUri,
  storageAdapters: StorageAdapter[],
  expiresIn: number
): Promise<string> {
  // Parse the storage URI to get the schema
  const url = new URL(storageUri);
  const schema = url.protocol.slice(0, -1); // Remove trailing ':'

  // Find compatible storage adapter
  const adapter = storageAdapters.find(adapter => 
    adapter.supportedSchemas.includes(schema)
  );

  if (!adapter) {
    throw new Error(`No storage adapter found for schema: ${schema}`);
  }

  return adapter.getSignedUrl(storageUri, expiresIn);
}