import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
// migrations/migrator.spec.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Migration0001HotUpdater0_13_0 } from "./Migration0001HotUpdater0_13_0";
import { S3Migrator } from "./migrator"; // Modify to actual code path

// Use aws-sdk-client-mock to mock S3Client
const s3Mock = mockClient(S3Client);

describe("S3Migration & S3Migrator with aws-sdk-client-mock", () => {
  beforeEach(() => {
    s3Mock.reset();
  });

  // Helper: create new S3Client with region specified
  const newS3Client = () => new S3Client({ region: "us-east-1" });

  it("should retrieve keys properly using getKeys", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "file1.txt" }, { Key: "file2.txt" }],
      NextContinuationToken: undefined,
    });

    const migration = new Migration0001HotUpdater0_13_0();
    migration.s3 = newS3Client();
    migration.bucketName = "dummy-bucket";
    // @ts-ignore - accessing protected method for testing purposes
    const keys = await migration.getKeys("");
    expect(keys).toEqual(["file1.txt", "file2.txt"]);
    expect(s3Mock.commandCalls(ListObjectsV2Command).length).toBe(1);
  });

  it("should read file content correctly using readFile", async () => {
    const dummyContent = "hello world";
    s3Mock.on(GetObjectCommand).resolves({
      // @ts-ignore - mocking S3 response
      Body: { transformToString: async () => dummyContent },
    });

    const migration = new Migration0001HotUpdater0_13_0();
    migration.s3 = newS3Client();
    migration.bucketName = "dummy-bucket";
    // @ts-ignore - accessing protected method for testing purposes
    const content = await migration.readFile("file.txt");
    expect(content).toBe(dummyContent);
  });

  it("should parse JSON correctly using readJson", async () => {
    const jsonArray = [{ fileUrl: "url1" }];
    s3Mock.on(GetObjectCommand).resolves({
      // @ts-ignore - mocking S3 response
      Body: { transformToString: async () => JSON.stringify(jsonArray) },
    });

    const migration = new Migration0001HotUpdater0_13_0();
    migration.s3 = newS3Client();
    migration.bucketName = "dummy-bucket";
    // @ts-ignore - accessing protected method for testing purposes
    const data = await migration.readJson<{ fileUrl: string }[]>("update.json");
    expect(data).toEqual(jsonArray);
  });

  it("should return null for invalid JSON in readJson", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      // @ts-ignore - mocking S3 response
      Body: { transformToString: async () => "invalid json" },
    });

    const migration = new Migration0001HotUpdater0_13_0();
    migration.s3 = newS3Client();
    migration.bucketName = "dummy-bucket";
    // @ts-ignore - accessing protected method for testing purposes
    const data = await migration.readJson("update.json");
    expect(data).toBeNull();
  });

  it("should move file successfully in non-dry-run mode (moveFile)", async () => {
    const migration = new Migration0001HotUpdater0_13_0();
    migration.s3 = newS3Client();
    migration.bucketName = "dummy-bucket";
    migration.dryRun = false;

    // Mock backup: reading original file
    s3Mock.on(GetObjectCommand).resolvesOnce({
      // @ts-ignore - mocking S3 response
      Body: { transformToString: async () => "original content" },
    });
    // Mock CopyObjectCommand, DeleteObjectCommand
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    // @ts-ignore - accessing protected method for testing purposes
    await migration.moveFile("source.txt", "destination.txt");

    expect(s3Mock.commandCalls(CopyObjectCommand).length).toBeGreaterThan(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand).length).toBeGreaterThan(0);
  });

  it("should propagate error from moveFile and throw error", async () => {
    const migration = new Migration0001HotUpdater0_13_0();
    migration.s3 = newS3Client();
    migration.bucketName = "dummy-bucket";
    migration.dryRun = false;
    // Override doUpdateFile to avoid Upload-related errors
    // @ts-ignore - accessing protected method for testing purposes
    migration.doUpdateFile = vi.fn(async () => {});

    // Mock backup: reading original file
    s3Mock.on(GetObjectCommand).resolvesOnce({
      // @ts-ignore - mocking S3 response
      Body: { transformToString: async () => "original content" },
    });
    // Mock CopyObjectCommand to throw error
    s3Mock.on(CopyObjectCommand).rejects(new Error("copy failed"));

    await expect(
      // @ts-ignore - accessing protected method for testing purposes
      migration.moveFile("source.txt", "destination.txt"),
    ).rejects.toThrow("copy failed");
  });

  it("should perform rollback correctly using doUpdateFile spy", async () => {
    const migration = new Migration0001HotUpdater0_13_0();
    migration.s3 = newS3Client();
    migration.bucketName = "dummy-bucket";
    migration.dryRun = false;
    // Set backup mapping: original file -> backup file
    // @ts-ignore - accessing protected property for testing purposes
    migration.backupMapping.set(
      "file.txt",
      "backup/hot-updater_0.13.0/file.txt",
    );

    // Mock GetObjectCommand for backup file read
    s3Mock
      .on(GetObjectCommand, { Key: "backup/hot-updater_0.13.0/file.txt" })
      .resolves({
        // @ts-ignore - mocking S3 response
        Body: { transformToString: async () => "backup content" },
      });
    // Spy on doUpdateFile to capture its call
    const doUpdateFileSpy = vi
      // @ts-ignore - accessing protected method for testing purposes
      .spyOn(migration, "doUpdateFile");

    await migration.rollback();

    expect(doUpdateFileSpy).toHaveBeenCalledWith("file.txt", "backup content");
    doUpdateFileSpy.mockRestore();
  });

  it("should trigger rollback and rethrow error on migration failure in S3Migrator", async () => {
    // Mock migrate.json load: empty array
    s3Mock.on(GetObjectCommand, { Key: "migrate.json" }).resolves({
      // @ts-ignore - mocking S3 response
      Body: { transformToString: async () => "[]" },
    });

    // Create failing migration
    const failingMigration = new Migration0001HotUpdater0_13_0();
    failingMigration.s3 = newS3Client();
    failingMigration.bucketName = "dummy-bucket";
    failingMigration.dryRun = false;
    failingMigration.migrate = vi.fn(async () => {
      throw new Error("migration failed");
    });
    const rollbackSpy = vi
      .spyOn(failingMigration, "rollback")
      .mockResolvedValue();

    const migrator = new S3Migrator({
      s3: newS3Client(),
      bucketName: "dummy-bucket",
      migrations: [failingMigration],
    });

    await expect(migrator.migrate({ dryRun: false })).rejects.toThrow(
      "migration failed",
    );
    expect(rollbackSpy).toHaveBeenCalled();
    rollbackSpy.mockRestore();
  });

  it("should process Migration0001HotUpdater0130 correctly", async () => {
    const migration = new Migration0001HotUpdater0_13_0();
    migration.s3 = newS3Client();
    migration.bucketName = "dummy-bucket";
    migration.dryRun = false;

    // Mock ListObjectsV2Command: return update.json, ios/file1.txt, android/file2.txt
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: "update.json" },
        { Key: "ios/file1.txt" },
        { Key: "android/file2.txt" },
      ],
      NextContinuationToken: undefined,
    });
    // Mock GetObjectCommand responses in sequence:
    s3Mock
      .on(GetObjectCommand)
      // 1. Reading update.json (readJson)
      .resolvesOnce({
        // @ts-ignore - mocking S3 response
        Body: {
          transformToString: async () => JSON.stringify([{ fileUrl: "url1" }]),
        },
      })
      // 2. backup for update.json
      .resolvesOnce({
        // @ts-ignore - mocking S3 response
        Body: { transformToString: async () => "original update.json" },
      })
      // 3. updateFile upload call
      .resolves({});
    // Mock ios/file1.txt backup and move operations
    s3Mock
      .on(GetObjectCommand)
      .resolvesOnce({
        // @ts-ignore - mocking S3 response
        Body: { transformToString: async () => "ios file content" },
      })
      .resolves({});
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
    // Mock android/file2.txt backup and move operations
    s3Mock
      .on(GetObjectCommand)
      .resolvesOnce({
        // @ts-ignore - mocking S3 response
        Body: { transformToString: async () => "android file content" },
      })
      .resolves({});
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    await migration.migrate();

    expect(s3Mock.commandCalls(ListObjectsV2Command).length).toBeGreaterThan(0);
  });
});
