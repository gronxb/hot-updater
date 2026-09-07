import type { InsightsModel } from "@hot-updater/plugin-core";

import type { BundleActivityInput } from "../bundle-activity";
import type { RecoveryReport } from "../insights-recovery";
import { readInsightsHistory } from "./insightsHistory";
import { buildRecoveryReport } from "./insightsRecovery";

export async function getBundleActivity(
  model: InsightsModel,
  inputs: readonly BundleActivityInput[],
  now = Date.now(),
) {
  if (inputs.length === 0) return {};
  // One bounded read for the visible page, independent of the management query.
  const history = await readInsightsHistory(model, "30d", now);
  const scopes = new Map<string, RecoveryReport>();
  const result = new Map<string, RecoveryReport>();
  for (const input of inputs) {
    const key = JSON.stringify([input.platform, input.channel]);
    let report = scopes.get(key);
    if (!report) {
      report = buildRecoveryReport(history, {
        platform: input.platform,
        channel: input.channel,
        window: "30d",
      });
      scopes.set(key, report);
    }
    result.set(input.releaseId, {
      ...report,
      series: report.series.filter(
        (series) => series.releaseId === input.releaseId,
      ),
    });
  }
  return Object.fromEntries(result);
}
