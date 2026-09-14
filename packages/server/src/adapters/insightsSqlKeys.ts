import {
  insightsHourlyBucketKey,
  insightsLifetimeMarkerKey,
  insightsReleaseKey,
} from "@hot-updater/plugin-core";
import type { PreparedInsightsEvent } from "@hot-updater/plugin-core/internal";

/** Bound SQL index sizes without truncating escaped or Unicode identities. */
export const insightsSqlKey = async (key: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

/** Resolve hashes before entering transactions, including synchronous SQLite. */
export const prepareInsightsSqlKeys = async (
  prepared: PreparedInsightsEvent,
): Promise<ReadonlyMap<string, string>> => {
  const logicalKeys = prepared.currentDeltas.map(({ release }) =>
    insightsReleaseKey(release),
  );
  if (prepared.firstLifetime !== null) {
    logicalKeys.push(
      insightsLifetimeMarkerKey(prepared.firstLifetime),
      insightsReleaseKey(prepared.firstLifetime.release),
    );
  }
  if (prepared.hourly !== null) {
    logicalKeys.push(
      insightsHourlyBucketKey(
        prepared.hourly.release,
        prepared.hourly.hourStartMs,
      ),
    );
  }
  return new Map(
    await Promise.all(
      [...new Set(logicalKeys)].map(
        async (key) => [key, await insightsSqlKey(key)] as const,
      ),
    ),
  );
};
