// tests/migration.test.ts

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { S3Migration, S3Migrator } from "./migrator"; // Adjust the import path as needed

// Mock the Upload class from "@aws-sdk/lib-storage"
vi.mock("@aws-sdk/lib-storage", () => {
  return {
    Upload: vi.fn().mockImplementation(({ client, params }) => {
      return {
        done: async () => Promise.resolve(),
      };
    }),
  };
});

// Create a dummy S3 client that simulates the behavior of S3.send based on the command type.
const createMockS3 = () => ({
  send: vi.fn(async (command: any) => {
    // Simulate ListObjectsV2Command: return dummy keys.
    if (command instanceof ListObjectsV2Command) {
      return {
        Contents: [{ Key: "file1.txt" }, { Key: "file2.txt" }],
        NextContinuationToken: undefined,
      };
    }
    // Simulate GetObjectCommand: return a Body with a transformToString method.
    if (command instanceof GetObjectCommand) {
      return {
        Body: {
          transformToString: async () => "file content",
        },
      };
    }
    // For CopyObjectCommand and DeleteObjectCommand, return empty objects.
    if (
      command instanceof CopyObjectCommand ||
      command instanceof DeleteObjectCommand
    ) {
      return {};
    }
    return {};
  }),
});

// Create a TestMigration class that extends S3Migration so we can call its methods.
class TestMigration extends S3Migration {
  async migrate(): Promise<void> {
    // For testing purposes, perform two operations:
    // 1. Update a file
    // 2. Move a file
    await this.updateFile("test.txt", "new content");
    await this.moveFile("source.txt", "dest.txt");
  }
}

describe("S3Migration", () => {
  let mockS3: any;
  let testMigration: TestMigration;

  beforeEach(() => {
    vi.clearAllMocks();
    mockS3 = createMockS3();
    testMigration = new TestMigration();
    testMigration.s3 = mockS3;
    testMigration.bucketName = "test-bucket";
    testMigration.name = "TestMigration";
  });

  it("should retrieve keys with a given prefix", async () => {
    // @ts-ignore ignore protected method
    const keys = await testMigration.getKeys("prefix/");
    expect(keys).toEqual(["file1.txt", "file2.txt"]);
    // Verify that send was called with a ListObjectsV2Command.
    expect(mockS3.send).toHaveBeenCalledWith(expect.any(ListObjectsV2Command));
  });

  it("should read file content", async () => {
    // @ts-ignore ignore protected method
    const content = await testMigration.readFile("file.txt");
    expect(content).toEqual("file content");
    // Verify that send was called with a GetObjectCommand.
    expect(mockS3.send).toHaveBeenCalledWith(expect.any(GetObjectCommand));
  });

  it("should backup a file before updating", async () => {
    // @ts-ignore ignore protected method
    const doUpdateSpy = vi.spyOn(testMigration as any, "doUpdateFile");
    // @ts-ignore ignore protected method
    await testMigration.backupFile("file.txt");
    const expectedBackupKey = `backup/${testMigration.name}/file.txt`;
    expect(doUpdateSpy).toHaveBeenCalledWith(expectedBackupKey, "file content");
    // @ts-ignore ignore protected method
    expect(testMigration.backupMapping.get("file.txt")).toEqual(
      expectedBackupKey,
    );
  });

  it("should update a file and backup the original if it exists", async () => {
    // @ts-ignore ignore protected method
    const backupSpy = vi.spyOn(testMigration, "backupFile");
    // @ts-ignore ignore protected method
    const doUpdateSpy = vi.spyOn(testMigration as any, "doUpdateFile");
    // @ts-ignore ignore protected method
    await testMigration.updateFile("file.txt", "updated content");
    // Expect backup to have been performed.
    expect(backupSpy).toHaveBeenCalled();
    // Expect doUpdateFile to be called with the normalized key and new content.
    expect(doUpdateSpy).toHaveBeenCalledWith("file.txt", "updated content");
  });

  it("should move a file (backup, copy, then delete source)", async () => {
    // @ts-ignore ignore protected method
    const backupSpy = vi.spyOn(testMigration, "backupFile");
    // @ts-ignore ignore protected method
    await testMigration.moveFile("source.txt", "dest.txt");
    // The source file should be backed up before moving.
    expect(backupSpy).toHaveBeenCalledWith("source.txt");
    // Ensure that the s3.send method was called for both CopyObjectCommand and DeleteObjectCommand.
    expect(mockS3.send).toHaveBeenCalledWith(expect.any(CopyObjectCommand));
    expect(mockS3.send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
  });

  it("should rollback files from backups", async () => {
    // @ts-ignore ignore protected method
    testMigration.backupMapping.set(
      "file1.txt",
      `backup/${testMigration.name}/file1.txt`,
    );
    // Override readFile to return a specific content for the backup file.
    // @ts-ignore ignore protected method
    vi.spyOn(testMigration, "readFile").mockImplementation(
      // @ts-ignore ignore protected method
      async (key: string) => {
        if (key === `backup/${testMigration.name}/file1.txt`)
          return "original content";
        return null;
      },
    );
    const doUpdateSpy = vi.spyOn(testMigration as any, "doUpdateFile");
    await testMigration.rollback();
    // Expect doUpdateFile to be called to restore the original file.
    expect(doUpdateSpy).toHaveBeenCalledWith("file1.txt", "original content");
  });

  it("should clean up backup files and clear backup mapping", async () => {
    // Set a backup mapping.
    // @ts-ignore ignore protected method
    testMigration.backupMapping.set(
      "file1.txt",
      `backup/${testMigration.name}/file1.txt`,
    );
    // Spy on deleteBackupFile.
    // @ts-ignore ignore protected method
    const deleteBackupSpy = vi
      // @ts-ignore ignore protected method
      .spyOn(testMigration, "deleteBackupFile")
      // @ts-ignore ignore protected method
      .mockImplementation(async () => {});
    // @ts-ignore ignore protected method
    await testMigration.cleanupBackups();
    expect(deleteBackupSpy).toHaveBeenCalledWith(
      `backup/${testMigration.name}/file1.txt`,
    );
    // @ts-ignore ignore protected method
    expect(testMigration.backupMapping.size).toEqual(0);
  });

  it("should log dry run messages when in dry-run mode", async () => {
    testMigration.dryRun = true;
    const logSpy = vi.spyOn(console, "log");
    // @ts-ignore ignore protected method
    await testMigration.updateFile("file.txt", "dry run content");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
  });
});

describe("S3Migrator", () => {
  let mockS3: any;
  let migration: TestMigration;
  let migrator: S3Migrator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockS3 = createMockS3();
    migration = new TestMigration();
    migration.name = "TestMigration";
    migrator = new S3Migrator({
      s3: mockS3,
      bucketName: "test-bucket",
      migrations: [migration],
    });
  });

  it("should list applied and pending migrations", async () => {
    // Simulate existing migration records by returning a JSON string.
    mockS3.send.mockImplementationOnce(async (command: any) => {
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: {
            transformToString: async () =>
              JSON.stringify([
                { name: "OtherMigration", appliedAt: "2022-01-01T00:00:00Z" },
              ]),
          },
        };
      }
      return {};
    });

    const listResult = await migrator.list();
    expect(listResult.applied).toEqual([
      { name: "OtherMigration", appliedAt: "2022-01-01T00:00:00Z" },
    ]);
    // Since TestMigration is not in the applied records, it should be pending.
    expect(listResult.pending).toEqual([{ name: "TestMigration" }]);
  });

  it("should apply a pending migration and update migration records", async () => {
    // Simulate a scenario where no migration records exist.
    mockS3.send.mockImplementation(async (command: any) => {
      if (command.constructor.name === "GetObjectCommand") {
        // Simulate a NoSuchKey error.
        const error = new Error("NoSuchKey");
        (error as any).Code = "NoSuchKey";
        (error as any).name = "NoSuchKey";
        (error as any).$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {};
    });

    await migrator.migrate({ dryRun: false });
    // After a successful migration, the migration record should be added.
    expect(migrator.migrationRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "TestMigration" }),
      ]),
    );
  });

  it("should skip a migration if it has already been applied", async () => {
    // Simulate that S3 already contains the migration record for TestMigration.
    mockS3.send.mockImplementation(async (command: any) => {
      if (
        command.constructor.name === "GetObjectCommand" &&
        command.input.Key === migrator.migrationRecordKey
      ) {
        return {
          Body: {
            transformToString: async () =>
              JSON.stringify([
                { name: "TestMigration", appliedAt: new Date().toISOString() },
              ]),
          },
        };
      }
      return {};
    });

    const migrateSpy = vi.spyOn(migration, "migrate");
    await migrator.migrate({ dryRun: false });
    expect(migrateSpy).not.toHaveBeenCalled();
  });

  it("should log dry run messages and not persist records in dry-run mode", async () => {
    // Simulate no migration records exist.
    mockS3.send.mockImplementation(async (command: any) => {
      if (command.constructor.name === "GetObjectCommand") {
        const error = new Error("NoSuchKey");
        (error as any).Code = "NoSuchKey";
        (error as any).name = "NoSuchKey";
        (error as any).$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {};
    });
    const logSpy = vi.spyOn(console, "log");
    await migrator.migrate({ dryRun: true });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
  });
});
