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
    );
  `;
};

const createGetUpdateInfo =
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
      file_url: string;
      file_hash: string;
      status: string;
    }>(
      `
      SELECT * FROM get_update_info('${platform}', '${appVersion}', '${bundleId}')
    `,
    );
    return result.rows[0] ? camelcaseKeys(result.rows[0]) : null;
  };

const createInsertBundleQuerys = (bundles: Bundle[]) => {
  return bundles.map(createInsertBundleQuery).join("\n");
};

describe("get_update_info", () => {
  let db: PGlite;
  let getUpdateInfo: ReturnType<typeof createGetUpdateInfo>;

  beforeAll(async () => {
    db = new PGlite();
    const sql = await prepareSql();
    await db.exec(sql);
    getUpdateInfo = createGetUpdateInfo(db);
  });

  beforeEach(async () => {
    await db.exec("DELETE FROM bundles");
  });

  afterAll(async () => {
    await db.close();
  });

  it("returns null when no bundles are provided", async () => {
    const bundles: Bundle[] = [];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("returns null when the app version does not qualify for the available higher version", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.1",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        forceUpdate: false,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("applies an update when a higher semver-compatible bundle is available", async () => {
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

    const update = await getUpdateInfo(bundles, {
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

  it("applies an update if forceUpdate is true for a matching version", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        forceUpdate: true,
      },
    ];
    const update = await getUpdateInfo(bundles, {
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

  it("applies an update for a matching version even if forceUpdate is false", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        forceUpdate: false,
      },
    ];

    const update = await getUpdateInfo(bundles, {
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

  it("applies an update when the app version is the same but the bundle is still considered higher", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000005",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000005",
      forceUpdate: false,
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      status: "UPDATE",
    });
  });

  it("falls back to an older enabled bundle when the latest is disabled", async () => {
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

    const update = await getUpdateInfo(bundles, {
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

  it("returns null if all bundles are disabled", async () => {
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

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("triggers a rollback if the latest bundle is disabled and no other updates are enabled", async () => {
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

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual(null);
  });

  it("applies an update when a same-version bundle is available and enabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        forceUpdate: false,
        fileUrl: "20240722210327/build.zip",
        fileHash:
          "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
        message: "",
        targetVersion: "1.0",
        id: "00000000-0000-0000-0000-000000000001",
        enabled: true,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000001",
      forceUpdate: false,
      status: "UPDATE",
      fileUrl: "20240722210327/build.zip",
      fileHash:
        "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
    });
  });

  it("forces a rollback if no matching bundle exists for the provided bundleId", async () => {
    const bundles: Bundle[] = [];

    const update = await getUpdateInfo(bundles, {
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

  it("returns null if the user is already up-to-date with an available bundle", async () => {
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

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("triggers a rollback if the previously used bundle no longer exists", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
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

  it("selects the next available bundle even if forceUpdate is false", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000003",
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

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      id: "00000000-0000-0000-0000-000000000003",
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("applies the highest available bundle even if the app version is unchanged", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000005", // Higher than the current version
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000004",
      },
      {
        ...DEFAULT_BUNDLE,
        platform: "ios",
        targetVersion: "1.0",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000003",
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

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      id: "00000000-0000-0000-0000-000000000005",
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("returns null if the newest matching bundle is disabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.0",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000003",
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

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("rolls back to an older enabled bundle if the current one is disabled", async () => {
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

    const update = await getUpdateInfo(bundles, {
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

  it("rolls back to the original bundle when all available bundles are disabled", async () => {
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

    const update = await getUpdateInfo(bundles, {
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
