import { useQuery } from "@tanstack/react-query";

import type { RecoveryInput } from "./insights-recovery";
import { getReleaseActivityRpc } from "./insights-recovery-rpc";

export type ReleaseActivityInput = Pick<
  RecoveryInput,
  "platform" | "channel"
> & {
  readonly releaseId: string;
  /** The release runs the native build's built-in bundle, which nothing downloads. */
  readonly builtIn?: boolean;
};

export type ReleaseActivityReport = {
  /** Installations that downloaded the release. */
  readonly downloads: number;
  /** Installations that reported running it, once each at the first such report. */
  readonly launched: number;
  /** Launches that crashed on it and rolled back. */
  readonly failedLaunches: number;
  readonly measuredAtMs: number;
};

/** Release activity for bundle rows; mounted only where the console reads it. */
export function useReleaseActivityQuery(
  inputs: readonly ReleaseActivityInput[],
) {
  // The server reads only what names a release.
  const sorted = inputs
    .map(({ releaseId, platform, channel }) => ({
      releaseId,
      platform,
      channel,
    }))
    .sort((a, b) => a.releaseId.localeCompare(b.releaseId));
  return useQuery({
    queryKey: ["release-activity", sorted],
    queryFn: () => getReleaseActivityRpc({ data: sorted }),
    enabled: sorted.length > 0,
    staleTime: 30_000,
  });
}
