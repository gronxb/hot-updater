import { 
  type GetBundlesArgs, 
  type Platform, 
  type UpdateInfo, 
  type UpdateStatus,
  NIL_UUID 
} from "@hot-updater/core";
import { filterCompatibleAppVersions, withJwtSignedUrl } from "@hot-updater/js";
import type { DatabaseAdapter, StorageAdapter, StorageUri } from "@hot-updater/plugin-core";

// Cloudflare Workers types
declare global {
  interface D1Database {
    prepare(query: string): D1PreparedStatement;
  }

  interface D1PreparedStatement {
    bind(...values: any[]): D1PreparedStatement;
    first(): Promise<any>;
    all(): Promise<{ results: any[] }>;
  }

  interface R2Bucket {
    url: string;
    createMultipartUpload(key: string): Promise<any>;
  }
}

export interface D1NodeDatabaseConfig {
  database: D1Database;
}

export interface R2NodeStorageConfig {
  bucket: R2Bucket;
  jwtSecret: string;
}

// D1 Database Adapter  
export function d1Database(config: { database: D1Database }): DatabaseAdapter {
  return {
    name: "d1",
    dependencies: ["@cloudflare/workers-types"],

    async getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null> {
      const { database } = config;

      let query: string;
      let params: any[];

      if (args._updateStrategy === "fingerprint") {
        query = `
          SELECT * FROM bundles 
          WHERE platform = ? 
          AND bundle_id = ? 
          AND fingerprint_hash = ?
          AND (min_bundle_id IS NULL OR min_bundle_id <= ?)
          ${args.channel ? "AND channel = ?" : "AND channel IS NULL"}
          ORDER BY created_at DESC 
          LIMIT 1
        `;
        params = [
          args.platform,
          args.bundleId,
          args.fingerprintHash,
          args.minBundleId || args.bundleId,
          ...(args.channel ? [args.channel] : []),
        ];
      } else {
        query = `
          SELECT * FROM bundles 
          WHERE platform = ? 
          AND bundle_id = ? 
          AND app_version = ?
          AND (min_bundle_id IS NULL OR min_bundle_id <= ?)
          ${args.channel ? "AND channel = ?" : "AND channel IS NULL"}
          ORDER BY created_at DESC 
          LIMIT 1
        `;
        params = [
          args.platform,
          args.bundleId,
          args.appVersion,
          args.minBundleId || args.bundleId,
          ...(args.channel ? [args.channel] : []),
        ];
      }

      const result = await database
        .prepare(query)
        .bind(...params)
        .first();

      if (!result) {
        return null;
      }

      return {
        id: result.id,
        shouldForceUpdate: result.should_force_update || false,
        message: result.message,
        status: result.status || "UPDATE",
        storageUri: result.storage_uri,
      };
    },

    async getTargetAppVersions(
      platform: Platform,
      minBundleId: string,
    ): Promise<string[]> {
      const { database } = config;

      const result = await database
        .prepare(`
        SELECT DISTINCT app_version 
        FROM bundles 
        WHERE platform = ? AND bundle_id >= ?
        ORDER BY app_version DESC
      `)
        .bind(platform, minBundleId)
        .all();

      return result.results.map((row: any) => row.app_version);
    },
  };
}

export function d1NodeDatabase(config: D1NodeDatabaseConfig): DatabaseAdapter {
  return {
    name: 'd1',
    dependencies: ['r2', 'cloudfront'],
    
    async getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null> {
      switch (args._updateStrategy) {
        case "appVersion":
          return appVersionStrategy(config.database, args);
        case "fingerprint":
          return fingerprintStrategy(config.database, args);
        default:
          return null;
      }
    },
    
    async getTargetAppVersions(platform: Platform, minBundleId: string): Promise<string[]> {
      const result = await config.database.prepare(
        `SELECT target_app_version FROM bundles WHERE platform = ? GROUP BY target_app_version`
      )
      .bind(platform)
      .all<{ target_app_version: string }>();
      
      return result.results.map(row => row.target_app_version);
    }
  };
}

// R2 Storage Adapter
export function r2Storage(config: {
  bucket: R2Bucket;
  jwtSecret: string;
}): StorageAdapter {
  return {
    name: "r2",
    supportedSchemas: ["r2://"],

    async getSignedUrl(
      storageUri: StorageUri,
      expiresIn: number,
    ): Promise<string> {
      const { bucket, jwtSecret } = config;

      // Parse storage URI: r2://bucket-name/path/to/file
      const uriParts = storageUri.replace("r2://", "").split("/");
      const key = uriParts.slice(1).join("/");

      // Generate signed URL using R2's built-in signing
      const signedUrl = await bucket.createMultipartUpload(key);

      // For now, return a simple URL - in production you'd want proper JWT signing
      return `${bucket.url}/${key}?token=${encodeURIComponent(jwtSecret)}`;
    },
  };
}

export function r2NodeStorage(config: R2NodeStorageConfig): StorageAdapter {
  return {
    name: 'r2',
    supportedSchemas: ['r2'],
    
    async getSignedUrl(storageUri: StorageUri, expiresIn: number): Promise<string> {
      // For R2, we use JWT signed URLs
      // Parse the R2 URI to get the key
      const url = new URL(storageUri);
      const key = url.pathname.substring(1); // Remove leading slash
      
      // Create a temporary URL for JWT signing
      const baseUrl = `https://${url.host}/${key}`;
      
      return withJwtSignedUrl(baseUrl, config.jwtSecret, expiresIn);
    }
  };
}

async function appVersionStrategy(
  DB: D1Database,
  args: GetBundlesArgs & { _updateStrategy: "appVersion" }
): Promise<UpdateInfo | null> {
  const { platform, appVersion, bundleId, minBundleId = NIL_UUID, channel = "production" } = args;
  
  const appVersionList = await DB.prepare(
    `SELECT target_app_version FROM bundles WHERE platform = ? GROUP BY target_app_version`
  )
  .bind(platform)
  .all<{ target_app_version: string }>();

  const targetAppVersionList = filterCompatibleAppVersions(
    appVersionList.results.map((group) => group.target_app_version),
    appVersion,
  );

  const sql = /* sql */ `
  WITH input AS (
    SELECT 
      ? AS app_platform,
      ? AS app_version,
      ? AS bundle_id,
      ? AS min_bundle_id,
      ? AS channel,
      '00000000-0000-0000-0000-000000000000' AS nil_uuid
  ),
  update_candidate AS (
    SELECT 
      b.id,
      b.should_force_update,
      b.message,
      b.storage_uri,
      'UPDATE' AS status
    FROM bundles b, input
    WHERE b.enabled = 1
      AND b.platform = input.app_platform
      AND b.id >= input.bundle_id
      AND b.id >= input.min_bundle_id
      AND b.channel = input.channel
      AND b.target_app_version IN (${targetAppVersionList
        .map((version) => `'${version}'`)
        .join(",")})
    ORDER BY b.id DESC 
    LIMIT 1
  ),
  rollback_candidate AS (
    SELECT 
      b.id,
      1 AS should_force_update,
      b.message,
      b.storage_uri,
      'ROLLBACK' AS status
    FROM bundles b, input
    WHERE b.enabled = 1
      AND b.platform = input.app_platform
      AND b.id < input.bundle_id
      AND b.id >= input.min_bundle_id
    ORDER BY b.id DESC
    LIMIT 1
  ),
  final_result AS (
    SELECT * FROM update_candidate
    UNION ALL
    SELECT * FROM rollback_candidate
    WHERE NOT EXISTS (SELECT 1 FROM update_candidate)
  )
  SELECT id, should_force_update, message, status, storage_uri
  FROM final_result, input
  WHERE id <> bundle_id
  
  UNION ALL
  
  SELECT 
    nil_uuid AS id,
    1 AS should_force_update,
    NULL AS message,
    'ROLLBACK' AS status,
    NULL AS storage_uri
  FROM input
  WHERE (SELECT COUNT(*) FROM final_result) = 0
    AND bundle_id > min_bundle_id;
`;

  const result = await DB.prepare(sql)
    .bind(platform, appVersion, bundleId, minBundleId, channel)
    .first<{
      id: string;
      should_force_update: number;
      status: UpdateStatus;
      message: string | null;
      storage_uri: string | null;
    }>();

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    shouldForceUpdate: Boolean(result.should_force_update),
    status: result.status,
    message: result.message,
    storageUri: result.storage_uri,
  };
}

async function fingerprintStrategy(
  DB: D1Database,
  args: GetBundlesArgs & { _updateStrategy: "fingerprint" }
): Promise<UpdateInfo | null> {
  const { platform, fingerprintHash, bundleId, minBundleId = NIL_UUID, channel = "production" } = args;
  
  const sql = /* sql */ `
  WITH input AS (
    SELECT 
      ? AS app_platform,
      ? AS bundle_id,
      ? AS min_bundle_id,
      ? AS channel,
      ? AS fingerprint_hash,
      '00000000-0000-0000-0000-000000000000' AS nil_uuid
  ),
  update_candidate AS (
    SELECT 
      b.id,
      b.should_force_update,
      b.message,
      b.storage_uri,
      'UPDATE' AS status
    FROM bundles b, input
    WHERE b.enabled = 1
      AND b.platform = input.app_platform
      AND b.id >= input.bundle_id
      AND b.id >= input.min_bundle_id
      AND b.channel = input.channel
      AND b.fingerprint_hash = input.fingerprint_hash
    ORDER BY b.id DESC 
    LIMIT 1
  ),
  rollback_candidate AS (
    SELECT 
      b.id,
      1 AS should_force_update,
      b.message,
      b.storage_uri,
      'ROLLBACK' AS status
    FROM bundles b, input
    WHERE b.enabled = 1
      AND b.platform = input.app_platform
      AND b.id < input.bundle_id
      AND b.id >= input.min_bundle_id
      AND b.channel = input.channel
      AND b.fingerprint_hash = input.fingerprint_hash
    ORDER BY b.id DESC
    LIMIT 1
  ),
  final_result AS (
    SELECT * FROM update_candidate
    UNION ALL
    SELECT * FROM rollback_candidate
    WHERE NOT EXISTS (SELECT 1 FROM update_candidate)
  )
  SELECT id, should_force_update, message, status, storage_uri
  FROM final_result, input
  WHERE id <> bundle_id
  
  UNION ALL
  
  SELECT 
    nil_uuid AS id,
    1 AS should_force_update,
    NULL AS message,
    'ROLLBACK' AS status,
    NULL AS storage_uri
  FROM input
  WHERE (SELECT COUNT(*) FROM final_result) = 0
    AND bundle_id > min_bundle_id;
`;

  const result = await DB.prepare(sql)
    .bind(platform, bundleId, minBundleId, channel, fingerprintHash)
    .first<{
      id: string;
      should_force_update: number;
      status: UpdateStatus;
      message: string | null;
      storage_uri: string | null;
    }>();

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    shouldForceUpdate: Boolean(result.should_force_update),
    status: result.status,
    message: result.message,
    storageUri: result.storage_uri,
  };
}