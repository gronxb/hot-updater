import type { E2eTarget } from "../shared/targets.ts";
import { type ExecuteAdb, executeAdb } from "./android-reverse.ts";

/**
 * Refuses a device whose memory page size the target can't run on. A 4 KB app
 * on a 16 KB device opens behind Android's page size compatibility dialog, so
 * every scenario would fail on the dialog instead of on the update it tests.
 */
export async function assertAndroidPageSize(
  target: Pick<E2eTarget, "name" | "android">,
  deviceId: string,
  env: NodeJS.ProcessEnv,
  execute: ExecuteAdb = executeAdb,
): Promise<void> {
  const required = target.android.pageSize;
  if (required === undefined) return;
  const output = await execute(
    ["-s", deviceId, "shell", "getconf", "PAGE_SIZE"],
    env,
  );
  const actual = Number(output.trim());
  if (!Number.isSafeInteger(actual) || actual <= 0) {
    throw new Error(
      `Could not read ${deviceId}'s page size: ${JSON.stringify(output)}`,
    );
  }
  if (actual !== required) {
    throw new Error(
      `The ${target.name} target needs a device with ${required / 1024} KB pages; ${deviceId} uses ${actual / 1024} KB`,
    );
  }
}
