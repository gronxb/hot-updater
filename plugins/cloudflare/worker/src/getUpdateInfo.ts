import { NIL_UUID, type UpdateInfo }from "@hot-updater/core";
import semver from "semver";

export async function getUpdateInfo(
    env: Env,
    appPlatform: "ios" | "android",
    appVersion: string,
    bundleId: string,
  ): Promise<UpdateInfo | null> {
    let finalResult: UpdateInfo | null = null;
  
    const updateStmt = env.DB.prepare(
      `SELECT id, target_app_version, file_url, file_hash, should_force_update
       FROM bundles
       WHERE enabled = 1 AND platform = ? AND id >= ?
       ORDER BY id DESC`
    );
    const updateResult = await updateStmt.bind(appPlatform, bundleId).all();
    const updateRows = updateResult.results as Array<{
      id: string;
      target_app_version: string;
      file_url: string | null;
      file_hash: string | null;
      should_force_update: boolean;
    }>;
  
    for (const row of updateRows) {
      if (semver.satisfies(row.target_app_version, appVersion)) {
        finalResult = {
          id: row.id,
          shouldForceUpdate: row.should_force_update,
          fileUrl: row.file_url,
          fileHash: row.file_hash,
          status: "UPDATE",
        };
        break;
      }
    }
  
    if (!finalResult) {
      const rollbackStmt = env.DB.prepare(
        `SELECT id, file_url, file_hash
         FROM bundles
         WHERE enabled = 1 AND platform = ? AND id < ?
         ORDER BY id DESC
         LIMIT 1`
      );
      const rollbackRow = await rollbackStmt.bind(appPlatform, bundleId).first<{
        id: string;
        file_url: string | null;
        file_hash: string | null;
      }>();
  
      if (rollbackRow) {
        finalResult = {
          id: rollbackRow.id,
          shouldForceUpdate: true, // 롤백인 경우 항상 강제 업데이트
          fileUrl: rollbackRow.file_url,
          fileHash: rollbackRow.file_hash,
          status: "ROLLBACK",
        };
      }
    }
  
    if (finalResult && finalResult.id === bundleId) {
      finalResult = null;
    }
  
    if (!finalResult && bundleId !== NIL_UUID) {
      finalResult = {
        id: NIL_UUID,
        shouldForceUpdate: true,
        fileUrl: null,
        fileHash: null,
        status: "ROLLBACK",
      };
    }
  
    return finalResult;
  }