import { useQuery } from "@tanstack/react-query";

import type { RecoveryInput } from "./insights-recovery";
import { getBundleActivityRpc } from "./insights-recovery-rpc";

export type BundleActivityInput = Pick<
  RecoveryInput,
  "platform" | "channel"
> & { readonly releaseId: string };

export type BundleActivityReport = {
  readonly downloads: number;
  readonly launches: number;
  readonly failedLaunches: number;
  readonly measuredAtMs: number;
  readonly coverage: import("@hot-updater/plugin-core").InsightsCoverage;
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
