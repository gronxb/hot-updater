import {
  createBlobDatabasePlugin,
  type DatabasePluginHooks,
} from "@hot-updater/plugin-core";
import { Storage } from "@google-cloud/storage";

export interface GCSDatabaseConfig {
  bucketName: string;
}

const storage = new Storage();

export const gcsDatabase = (
  config: GCSDatabaseConfig,
  hooks?: DatabasePluginHooks,
) => {
  const { bucketName } = config;

  // List update.json paths for each platform in parallel
  async function listUpdateJsonKeys(prefix: string): Promise<string[]> {
    const bucket = storage.bucket(bucketName);
    const [files, a, b] = await bucket.getFiles({ prefix });
    // TODO - Handle pagination
    return files.map((file) => file.name);
  }

  /**
   * Loads JSON data from GCS.
   * Returns null if an error occurs.
   */
  async function getJsonFromGCS<T>(key: string): Promise<T | null> {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(key);

    try {
      const data = await file.download();
      const json = JSON.parse(data.toString());
      return json;
    } catch (error) {
      console.error("Failed to download or parse JSON:", error);
      throw null;
    }
  }

  /**
   * Converts data to JSON string and uploads to GCS.
   */
  async function uploadJsonToGCS<T>(fileName: string, jsonObject: T) {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileName);
    const jsonString = JSON.stringify(jsonObject);

    try {
      await file.save(jsonString, {
        contentType: "application/json",
      });
      console.log("JSON uploaded successfully!");
    } catch (error) {
      console.error("Failed to upload JSON:", error);
      throw error;
    }
  }

  /**
   * Delete a file from GCS
   * @param fileName
   */
  async function deleteObjectGCS(fileName: string) {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileName);
    await file.delete();
  }

  const invalidatePaths = async (paths: string[]) => {};

  return createBlobDatabasePlugin(
    "gcsDatabase",
    listUpdateJsonKeys,
    getJsonFromGCS,
    uploadJsonToGCS,
    deleteObjectGCS,
    invalidatePaths,
    hooks,
  );
};
