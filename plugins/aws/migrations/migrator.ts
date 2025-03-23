import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import picocolors from "picocolors";

interface MigrationRecord {
  name: string;
  appliedAt: string;
}

interface S3MigratorOptions {
  s3: S3Client;
  bucketName: string;
  dryRun?: boolean; // Option to enable dry-run mode
}

/**
 * S3Migration
 * Base class that each migration script extends.
 * Provides common S3-related methods (getKeys, readJson, updateFile, moveFile, backup, rollback, etc.)
 */
export abstract class S3Migration {
  name!: string;
  s3!: S3Client;
  bucketName!: string;
  dryRun = false; // Flag for dry-run mode

  // Map to store backup info: original key -> backup key
  protected backupMapping: Map<string, string> = new Map();

  // Performs the actual file upload without backup logic
  protected async doUpdateFile(key: string, content: string): Promise<void> {
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

  // Reads the file at the specified key and returns its content as a string
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
      console.error(picocolors.red(`Error reading file ${key}:`), error);
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
        console.error(picocolors.red(`Error parsing JSON from ${key}:`), e);
      }
    }
    return null;
  }

  // Backs up a file before updating/moving.
  // The backup file is stored at: backup/<migrationName>/<originalKey>
  protected async backupFile(key: string): Promise<void> {
    if (this.dryRun) {
      console.log(picocolors.yellow(`[DRY RUN] Would backup file ${key}`));
      return;
    }
    const content = await this.readFile(key);
    if (content !== null) {
      const backupKey = `backup/${this.name}/${key}`;
      await this.doUpdateFile(backupKey, content);
      this.backupMapping.set(key, backupKey);
      console.log(picocolors.green(`Backed up ${key} to ${backupKey}`));
    } else {
      console.log(picocolors.yellow(`No existing file at ${key} to backup.`));
    }
  }

  // Updates (uploads) a file at the specified key.
  // In dry-run mode, it logs what would be updated.
  // Backs up the original file if it exists.
  protected async updateFile(key: string, content: string): Promise<void> {
    const normalizedKey = key.startsWith("/") ? key.substring(1) : key;
    if (this.dryRun) {
      console.log(
        picocolors.yellow(
          `[DRY RUN] Updated ${picocolors.bold(normalizedKey)}:\n${content}`,
        ),
      );
      return;
    }
    // Backup the original file if it exists
    const originalContent = await this.readFile(key);
    if (originalContent !== null) {
      await this.backupFile(key);
    }
    await this.doUpdateFile(normalizedKey, content);
    console.log(
      picocolors.green(
        `Updated ${picocolors.bold(normalizedKey)}:\n${content}`,
      ),
    );
  }

  // Moves a single file from one location to another.
  // In dry-run mode, it logs what would be moved.
  // Backs up the source file before moving.
  protected async moveFile(from: string, to: string): Promise<void> {
    if (this.dryRun) {
      console.log(
        picocolors.yellow(
          `[DRY RUN] ${picocolors.bold(from)} -> ${picocolors.bold(to)}`,
        ),
      );
      return;
    }
    // Backup the source file before moving
    await this.backupFile(from);
    try {
      // Use URL encoding for the CopySource to handle special characters
      const copyCommand = new CopyObjectCommand({
        Bucket: this.bucketName,
        CopySource: `${this.bucketName}/${encodeURIComponent(from)}`,
        Key: to,
      });
      await this.s3.send(copyCommand);
      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: from,
      });
      await this.s3.send(deleteCommand);
      console.log(
        picocolors.green(`${picocolors.bold(from)} -> ${picocolors.bold(to)}`),
      );
    } catch (error) {
      console.error(
        picocolors.red(`Error moving file from ${from} to ${to}:`),
        error,
      );
      // Rethrow the error to propagate it and halt the migration process
      throw error;
    }
  }

  // Rollback method: restores files from backups stored in backupMapping
  public async rollback(): Promise<void> {
    console.log(
      picocolors.magenta(`Starting rollback for migration ${this.name}...`),
    );
    for (const [originalKey, backupKey] of this.backupMapping.entries()) {
      const backupContent = await this.readFile(backupKey);
      if (backupContent !== null) {
        console.log(
          picocolors.blue(
            `Restoring backup for ${originalKey} from ${backupKey}`,
          ),
        );
        await this.doUpdateFile(originalKey, backupContent);
      } else {
        console.error(
          picocolors.red(
            `Failed to read backup for ${originalKey} at ${backupKey}`,
          ),
        );
      }
    }
    console.log(
      picocolors.green(`Rollback completed for migration ${this.name}.`),
    );
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
  migrationRecordKey = "migrate.json";
  migrationRecords: MigrationRecord[] = [];
  migrations: S3Migration[];

  constructor(options: S3MigratorOptions & { migrations: S3Migration[] }) {
    this.bucketName = options.bucketName;
    this.s3 = options.s3;
    this.migrations = options.migrations;
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
          console.error(
            picocolors.red("Failed to parse migration records JSON:"),
            jsonError,
          );
          this.migrationRecords = [];
        }
      }
    } catch (error: any) {
      // Enhanced error handling for NoSuchKey error
      if (
        error.Code === "NoSuchKey" ||
        error.name === "NoSuchKey" ||
        error.$metadata?.httpStatusCode === 404
      ) {
        this.migrationRecords = [];
      } else {
        throw error;
      }
    }
  }

  private async saveMigrationRecords(dryRun: boolean): Promise<void> {
    if (dryRun) {
      console.log(
        picocolors.yellow("[DRY RUN] Would save migration records:"),
        this.migrationRecords,
      );
      return;
    }
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

  /**
   * Returns a JSON object containing applied and pending migrations.
   */
  async list(): Promise<{
    applied: Array<{ name: string; appliedAt: string }>;
    pending: Array<{ name: string }>;
  }> {
    await this.loadMigrationRecords();

    const applied = this.migrationRecords.map((record) => ({
      name: record.name,
      appliedAt: record.appliedAt,
    }));

    const pendingMigrations = this.migrations.filter(
      (migration) =>
        !this.migrationRecords.some((record) => record.name === migration.name),
    );

    const pending = pendingMigrations.map((migration) => ({
      name: migration.name,
    }));

    return { applied, pending };
  }

  async migrate({
    dryRun,
  }: {
    dryRun: boolean;
  }): Promise<void> {
    await this.loadMigrationRecords();

    for (const migration of this.migrations) {
      const alreadyApplied = this.migrationRecords.some(
        (record) => record.name === migration.name,
      );
      if (alreadyApplied) {
        console.log(
          picocolors.yellow(
            `Migration ${migration.name} already applied, skipping.`,
          ),
        );
        continue;
      }

      console.log(
        picocolors.magenta(`Applying migration ${migration.name}...`),
      );
      migration.s3 = this.s3;
      migration.bucketName = this.bucketName;
      migration.dryRun = dryRun;

      try {
        await migration.migrate();
        if (!dryRun) {
          this.migrationRecords.push({
            name: migration.name,
            appliedAt: new Date().toISOString(),
          });
          console.log(
            picocolors.green(
              `${picocolors.bold(migration.name)} applied successfully.`,
            ),
          );
        } else {
          console.log(
            picocolors.yellow(
              `[DRY RUN] ${picocolors.bold(migration.name)} applied successfully`,
            ),
          );
        }
      } catch (error) {
        console.error(
          picocolors.red(
            `Migration ${migration.name} failed. Initiating rollback...`,
          ),
          error,
        );
        await migration.rollback();
        throw error;
      }
    }

    await this.saveMigrationRecords(dryRun);
    if (!dryRun) {
      console.log(picocolors.blue("All migrations applied."));
    } else {
      console.log(
        picocolors.blue(
          "[DRY RUN] Completed dry-run. No changes were applied.",
        ),
      );
    }
  }
}
