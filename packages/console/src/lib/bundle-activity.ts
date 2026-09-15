import type {
  InsightsHistoryCoverage,
  ReleaseActivity,
} from "@hot-updater/plugin-core";
import { useQuery } from "@tanstack/react-query";

import type { RecoveryInput } from "./insights-recovery";
import { getBundleActivityRpc } from "./insights-recovery-rpc";

export type BundleActivityInput = Pick<RecoveryInput, "channel"> & {
  readonly platform: "ios" | "android";
  readonly releaseId: string;
};

export type BundleActivityReport = {
  readonly coverage: InsightsHistoryCoverage;
  readonly measuredAtMs: number;
  readonly summary: ReleaseActivity["summary"];
  readonly truncated: boolean;
};

export function useBundleActivityQuery(inputs: readonly BundleActivityInput[]) {
  const sorted = [...inputs].sort((a, b) =>
    a.releaseId.localeCompare(b.releaseId),
  );
  return useQuery({
    queryKey: ["bundle-activity", sorted],
    queryFn: () => getBundleActivityRpc({ data: sorted }),
    enabled: sorted.length > 0,
    staleTime: 30_000,
  });
}
