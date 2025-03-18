import { Storage } from "@google-cloud/storage";

const storage = new Storage();

/**
 * Loads JSON data from GCS.
 * Returns null if an error occurs.
 */
export async function getJsonFromGCS<T>(
  bucketName: string,
  key: string
): Promise<T | null> {
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
export async function uploadJsonToGCS<T>(
  bucketName: string,
  fileName: string,
  jsonObject: T
) {
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

export async function deleteObjectGCS(bucketName: string, fileName: string) {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(fileName);
  await file.delete();
}

// List update.json paths for each platform in parallel
export async function listUpdateJsonKeys(
  bucketName: string,
  platform: string
): Promise<string[]> {
  const bucket = storage.bucket(bucketName);
  const [files, a, b] = await bucket.getFiles({ prefix: `${platform}/` });
  const pattern = new RegExp(`^${platform}/[^/]+/update\\.json$`);
  // TODO - Handle pagination
  return files.map((file) => file.name).filter((key) => pattern.test(key));
}



export async function getPublicDownloadURL(bucketName: string, fileName: string) {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(fileName);
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 15 * 60 * 1000, // 15 minutes
  });
  return url;
}