import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { merge, omit } from "es-toolkit";

interface MigrationRecord {
  name: string;
  appliedAt: string;
}

interface S3MigratorOptions {
  credentials: S3ClientConfig["credentials"];
  region: string;
  bucketName: string;
}

/**
 * S3Migration
 * Base class that each migration script inherits from.
 * Provides common S3-related methods (getKeys, readJson, updateFile, moveFile, etc.)
 */
export abstract class S3Migration {
  name!: string;
  s3!: S3Client;
  bucketName!: string;

  // Retrieves all object keys that start with the specified prefix
  protected async getKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined = undefined;
    do {
      const command: ListObjectsV2Command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix.startsWith("/") ? prefix.substring(1) : prefix,
        ContinuationToken: continuationToken,
      });
      const data = await this.s3.send(command);
      if (data.Contents) {
        for (const item of data.Contents) {
          if (item.Key) {
            keys.push(item.Key);
          }
        }
      }
      continuationToken = data?.NextContinuationToken;
    } while (continuationToken);
    return keys;
  }

  // Reads the file at the specified key and returns its contents as a string
  protected async readFile(key: string): Promise<string | null> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key.startsWith("/") ? key.substring(1) : key,
      });
      const response = await this.s3.send(command);
      if (response.Body) {
        return await response.Body.transformToString();
      }
      return null;
    } catch (error) {
      console.error(`Error reading file ${key}:`, error);
      return null;
    }
  }

  // Reads the file at the specified key and parses it as JSON
  protected async readJson<T>(key: string): Promise<T | null> {
    const content = await this.readFile(key);
    if (content) {
      try {
        return JSON.parse(content);
      } catch (e) {
        console.error(`Error parsing JSON from ${key}:`, e);
      }
    }
    return null;
  }

  // Updates (uploads) a file at the specified key
  protected async updateFile(key: string, content: string): Promise<void> {
    const normalizedKey = key.startsWith("/") ? key.substring(1) : key;
    const upload = new Upload({
      client: this.s3,
      params: {
        Bucket: this.bucketName,
        Key: normalizedKey,
        Body: content,
      },
    });
    await upload.done();
  }

  // Moves a single file from one location to another
  protected async moveFile(from: string, to: string): Promise<void> {
    try {
      // Copy the file
      const copyCommand = new CopyObjectCommand({
        Bucket: this.bucketName,
        CopySource: `${this.bucketName}/${from}`,
        Key: to,
      });
      await this.s3.send(copyCommand);
      // Delete the original file after copying
      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: from,
      });
      await this.s3.send(deleteCommand);
      console.log(`Moved file from ${from} to ${to}`);
    } catch (error) {
      console.error(`Error moving file from ${from} to ${to}:`, error);
    }
  }

  abstract migrate(): Promise<void>;
}

/**
 * S3Migrator
 * Manages migration records and sequentially executes the provided migration scripts.
 */
export class S3Migrator {
  s3: S3Client;
  bucketName: string;
  options: S3MigratorOptions;
  migrationRecordKey = "migrate.json";
  migrationRecords: MigrationRecord[] = [];

  constructor(options: S3MigratorOptions) {
    this.options = options;
    this.bucketName = options.bucketName;
    this.s3 = new S3Client({
      credentials: options.credentials,
      region: options.region,
    });
  }

  private async loadMigrationRecords(): Promise<void> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: this.migrationRecordKey,
      });
      const response = await this.s3.send(command);
      if (response.Body) {
        const bodyContents = await response.Body.transformToString();
        try {
          this.migrationRecords = JSON.parse(bodyContents);
        } catch (jsonError) {
          console.error("Failed to parse migration records JSON:", jsonError);
          this.migrationRecords = [];
        }
      }
    } catch (error: any) {
      if (error.Code === "NoSuchKey" || error.name === "NoSuchKey") {
        this.migrationRecords = [];
      } else {
        throw error;
      }
    }
  }

  private async saveMigrationRecords(): Promise<void> {
    const body = JSON.stringify(this.migrationRecords, null, 2);
    const upload = new Upload({
      client: this.s3,
      params: {
        Bucket: this.bucketName,
        Key: this.migrationRecordKey,
        Body: body,
      },
    });
    await upload.done();
  }

  async migrate(migrations: S3Migration[]): Promise<void> {
    await this.loadMigrationRecords();

    for (const migration of migrations) {
      const alreadyApplied = this.migrationRecords.some(
        (record) => record.name === migration.name,
      );
      if (alreadyApplied) {
        console.log(`Migration ${migration.name} already applied, skipping.`);
        continue;
      }

      console.log(`Applying migration ${migration.name}...`);
      migration.s3 = this.s3;
      migration.bucketName = this.bucketName;

      await migration.migrate();

      this.migrationRecords.push({
        name: migration.name,
        appliedAt: new Date().toISOString(),
      });
      console.log(`Migration ${migration.name} applied successfully.`);
    }

    await this.saveMigrationRecords();
    console.log("All migrations applied.");
  }
}

/**
 * Migration0001HotUpdater0130
 * 1. Retrieves all object keys in the bucket,
 * 2. If update.json exists, uses the readJson helper to read the JSON array,
 *    then removes the fileUrl field from each item and merges channel: "production" before updating.
 * 3. Moves files that start with ios/ or android/ under the production/ prefix.
 */
export class Migration0001HotUpdater0130 extends S3Migration {
  name = "hot-updater_0.13.0";

  async migrate(): Promise<void> {
    // Query all keys
    const keys = await this.getKeys("");
    console.log("All keys in bucket:", keys);

    // Process update.json file (update.json is always an array)
    if (keys.includes("update.json")) {
      const data = await this.readJson<{
        fileUrl: string;
      }>("update.json");
      if (data && Array.isArray(data)) {
        const updatedData = data.map((item) =>
          merge(omit(item, ["fileUrl"]), { channel: "production" }),
        );
        await this.updateFile(
          "update.json",
          JSON.stringify(updatedData, null, 2),
        );
        console.log("update.json updated successfully.");
      } else {
        console.log("update.json does not contain an array.");
      }
    }

    // Move files to production prefix: move files that start with ios/ or android/ and don't already have the production/ prefix
    for (const key of keys) {
      if (key === "update.json") continue;
      if (key.startsWith("production/")) continue;
      if (/^(ios|android)\//.test(key)) {
        const newKey = `production/${key}`;
        await this.moveFile(key, newKey);
      }
    }
  }
}

/**
 * runMigrate
 * Function that creates an S3Migrator and executes migration scripts
 */
export async function runMigrate() {
  const migrator = new S3Migrator({
    credentials: {
      accessKeyId: "YOUR_ACCESS_KEY",
      secretAccessKey: "YOUR_SECRET_KEY",
    },
    region: "YOUR_REGION",
    bucketName: "YOUR_BUCKET_NAME",
  });
  await migrator.migrate([new Migration0001HotUpdater0130()]);
}
