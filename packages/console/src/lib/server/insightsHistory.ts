import type {
  BundleEventRow,
  InsightsEventCursor,
  InsightsModel,
} from "@hot-updater/plugin-core";

import { recoveryWindows, type RecoveryInput } from "../insights-recovery";

export async function readInsightsHistory(
  model: InsightsModel,
  window: RecoveryInput["window"],
  beforeReceivedAtMs = Date.now(),
) {
  const { durationMs, intervalMs } = recoveryWindows[window];
  const sinceMs = Math.max(0, beforeReceivedAtMs - durationMs);
  let completeSinceMs = sinceMs;
  let after: InsightsEventCursor | undefined;
  let truncated = false;
  const events: BundleEventRow[] = [];
  while (events.length < 50_000) {
    const limit = Math.min(100, 50_000 - events.length);
    const rows = await model.listEvents({
      filter: { kind: "all" },
      sinceMs,
      beforeReceivedAtMs,
      after,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    events.push(...page);
    const last = page.at(-1);
    if (!last || rows.length <= limit) break;
    after = { id: last.id, receivedAtMs: last.received_at_ms };
    if (events.length === 50_000) {
      truncated = true;
      // Exclude the partially read interval, including its unknown denominator.
      completeSinceMs =
        Math.floor(last.received_at_ms / intervalMs) * intervalMs + intervalMs;
    }
  }
  return {
    events: events
      .filter((row) => row.received_at_ms >= completeSinceMs)
      .reverse(),
    sinceMs: completeSinceMs,
    beforeReceivedAtMs,
    intervalMs,
    truncated,
  };
}

export type InsightsHistory = Awaited<ReturnType<typeof readInsightsHistory>>;
