import { PGlite } from "@electric-sql/pglite";
import camelcaseKeys from "camelcase-keys";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Bundle } from "../../../packages/utils/src/types";
import { NIL_UUID } from "../../../packages/utils/src/uuid";
import { prepareSql } from "./prepareSql";

const DEFAULT_BUNDLE = {
  fileUrl: "http://example.com/bundle.zip",
  fileHash: "hash",
  platform: "ios",
  gitCommitHash: null,
  message: null,
} as const;

const createInsertBundleQuery = (bundle: Bundle) => {
  return `
    INSERT INTO bundles (
      id, file_url, file_hash, platform, target_version,
      force_update, enabled, git_commit_hash, message
    ) VALUES (
      '${bundle.id}',
      '${bundle.fileUrl}',
      '${bundle.fileHash}',
      '${bundle.platform}',
      '${bundle.targetVersion}',
      ${bundle.forceUpdate},
      ${bundle.enabled},
      ${bundle.gitCommitHash ? `'${bundle.gitCommitHash}'` : "null"},
      ${bundle.message ? `'${bundle.message}'` : "null"}
    )
  `;
};

const createCheckForUpdate =
  (db: PGlite) =>
  async (
    bundles: Bundle[],
    {
      appVersion,
      bundleId,
      platform,
    }: {
      appVersion: string;
      bundleId: string;
      platform: string;
    },
  ) => {
    await db.exec(createInsertBundleQuerys(bundles));

    const result = await db.query<{
      id: string;
      force_update: boolean;
      enabled: boolean;
      file_url: string;
      file_hash: string;
      status: string;
    }>(
      `
      SELECT * FROM get_update_info('${platform}', '${bundleId}', '${appVersion}')
    `,
    );
    return result.rows[0] ? camelcaseKeys(result.rows[0]) : null;
  };

const createInsertBundleQuerys = (bundles: Bundle[]) => {
  return bundles.map(createInsertBundleQuery).join("\n");
};

describe("get_update_info", () => {
  let db: PGlite;
  let checkForUpdate: ReturnType<typeof createCheckForUpdate>;

  beforeAll(async () => {
    db = new PGlite();
    const sql = await prepareSql();
    await db.exec(sql);
    checkForUpdate = createCheckForUpdate(db);
  });

  beforeEach(async () => {
    await db.exec("DELETE FROM bundles");
  });

  afterAll(async () => {
    await db.close();
  });

  it("should return null if no update information is available", async () => {
    const bundles: Bundle[] = [];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("should return null if no update is available when the app version is higher", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.1",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        forceUpdate: false,
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("should update if a higher bundle with semver version exists", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.x.x",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        forceUpdate: false,
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
        forceUpdate: false,
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000002",
      forceUpdate: false,
      status: "UPDATE",
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
    });
  });

  it("should update if a higher bundle version exists and forceUpdate is set to true", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        forceUpdate: true,
      },
    ];
    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });

    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000001",
      forceUpdate: true,
      status: "UPDATE",
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
    });
  });

  it("should update if a higher bundle version exists and forceUpdate is set to false", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        forceUpdate: false,
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000001",
      forceUpdate: false,
      status: "UPDATE",
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
    });
  });

  it("should update even if the app version is the same and the bundle version is significantly higher", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "5",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "5",
      forceUpdate: false,
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      status: "UPDATE",
    });
  });

  it("should update if the latest version is not available but a previous version is available", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      id: "00000000-0000-0000-0000-000000000001",
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("should not update if all updates are disabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("should rollback to the original bundle when receiving the latest bundle but all updates are disabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual(null);
  });

  it("should update if the latest version is available and the app version is the same", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        forceUpdate: false,
        fileUrl: "20240722210327/build.zip",
        fileHash:
          "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
        message: "",
        targetVersion: "1.0",
        id: "20240722210327",
        enabled: true,
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "20240722210327",
      forceUpdate: false,
      status: "UPDATE",
      fileUrl: "20240722210327/build.zip",
      fileHash:
        "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
    });
  });

  it("should return null if no update information is available", async () => {
    const bundles: Bundle[] = [];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileUrl: null,
      fileHash: null,
      id: NIL_UUID,
      forceUpdate: true, // Cause the app to reload
      status: "ROLLBACK",
    });
  });

  it("should return null if no update is available when the app version is higher", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("should rollback if the latest bundle is deleted", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileHash: "hash",
      fileUrl: "http://example.com/bundle.zip",
      id: "00000000-0000-0000-0000-000000000001",
      forceUpdate: true,
      status: "ROLLBACK",
    });
  });

  it("should update if a higher bundle version exists and forceUpdate is set to false", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "3",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      id: "3",
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("should update even if the app version is the same and the bundle version is significantly higher", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "5", // Higher than the current version
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "4",
      },
      {
        ...DEFAULT_BUNDLE,
        platform: "ios",
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "3",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      id: "5",
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("should not update if the latest version is disabled and matches the current version", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "3",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: true,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("should rollback to a previous version if the current version is disabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });

    expect(update).toStrictEqual({
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      id: "00000000-0000-0000-0000-000000000001",
      forceUpdate: true, // Cause the app to reload
      status: "ROLLBACK",
    });
  });

  it("should rollback to the original bundle when receiving the latest bundle but all updates are disabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: NIL_UUID,
      fileUrl: null,
      fileHash: null,
      forceUpdate: true, // Cause the app to reload
      status: "ROLLBACK",
    });
  });
});
