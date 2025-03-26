import { S3Client } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it } from "vitest";
import { Migration0001HotUpdater0_13_0 } from "./Migration0001HotUpdater0_13_0";
import { S3Migrator } from "./migrator";
import { getFakeBucket, resetFakeBucket, setupS3Mock } from "./s3MockUtil";

describe("Migration0001HotUpdater0_13_0 integration test", () => {
  beforeEach(() => {
    setupS3Mock();
    resetFakeBucket({
      "ios/target-app-version.json": JSON.stringify(["1.0.x"]),
      "ios/1.0.x/update.json": JSON.stringify([
        {
          id: "0001",
          shouldForceUpdate: true,
          fileUrl: "https://example.com/update2.json",
        },
      ]),
      "android/target-app-version.json": JSON.stringify(["1.0.x"]),
      "android/1.0.x/update.json": JSON.stringify([
        {
          id: "0000",
          shouldForceUpdate: true,
          fileUrl: "https://example.com/update.json",
        },
      ]),
      "android/1.0.2/update.json": JSON.stringify([
        {
          id: "0003",
          shouldForceUpdate: true,
          fileUrl: "https://example.com/update.json",
        },
        {
          id: "0002",
          shouldForceUpdate: true,
          fileUrl: "https://example.com/update.json",
        },
      ]),
    });
  });

  it("should migrate files correctly", async () => {
    const s3 = new S3Client({ region: "us-east-1" });

    // migration 인스턴스 생성 및 설정
    const migration = new Migration0001HotUpdater0_13_0();
    migration.s3 = s3;
    migration.bucketName = "dummy-bucket";
    migration.dryRun = false;

    const migrator = new S3Migrator({
      s3,
      bucketName: "dummy-bucket",
      migrations: [migration],
    });

    await migrator.migrate({ dryRun: false });

    const fakeBucket = getFakeBucket();
    // biome-ignore lint/performance/noDelete: <explanation>
    delete fakeBucket["migrate.json"];

    expect(fakeBucket).toEqual({
      "production/ios/target-app-version.json": JSON.stringify(["1.0.x"]),
      "production/ios/1.0.x/update.json": JSON.stringify([
        {
          id: "0001",
          shouldForceUpdate: true,
          channel: "production",
        },
      ]),
      "production/android/target-app-version.json": JSON.stringify(["1.0.x"]),
      "production/android/1.0.x/update.json": JSON.stringify([
        {
          id: "0000",
          shouldForceUpdate: true,
          channel: "production",
        },
      ]),
      "production/android/1.0.2/update.json": JSON.stringify([
        {
          id: "0003",
          shouldForceUpdate: true,
          channel: "production",
        },
        {
          id: "0002",
          shouldForceUpdate: true,
          channel: "production",
        },
      ]),
    });
  });
});
