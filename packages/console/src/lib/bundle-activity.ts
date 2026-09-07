import { useQuery } from "@tanstack/react-query";

import type { RecoveryInput } from "./insights-recovery";
import { getBundleActivityRpc } from "./insights-recovery-rpc";

export type BundleActivityInput = Pick<
  RecoveryInput,
  "platform" | "channel"
> & { readonly releaseId: string };

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
