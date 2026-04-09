import { DEFAULT_ROLLOUT_COHORT_COUNT } from "@hot-updater/core";
import type { Bundle } from "@hot-updater/plugin-core";
import { createColumnHelper } from "@tanstack/react-table";
import { Fingerprint, Package } from "lucide-react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import { EnabledStatusIcon } from "@/components/EnabledStatusIcon";
import { PlatformIcon } from "@/components/PlatformIcon";
import { RolloutPercentageBadge } from "@/components/RolloutPercentageBadge";
import { TimestampDisplay } from "@/components/TimestampDisplay";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const columnHelper = createColumnHelper<Bundle>();

function StackedBundleIdCell({
  bundle,
  depth,
}: {
  bundle: Bundle;
  depth: number;
}) {
  const baseBundleId = bundle.metadata?.diff_base_bundle_id;

  return (
    <div className="min-w-[180px] space-y-1">
      <div className="flex items-center gap-2">
        {depth > 0 ? (
          <div className="flex items-center gap-1">
            {Array.from({ length: depth }).map((_, index) => (
              <span
                key={`${bundle.id}-stack-${index}`}
                className="h-5 w-2 rounded-full bg-linear-to-b from-border via-border/70 to-transparent"
              />
            ))}
          </div>
        ) : null}
        <BundleIdDisplay bundleId={bundle.id} />
      </div>
      {baseBundleId ? (
        <div className="text-[11px] text-muted-foreground">
          stacked on{" "}
          <span className="font-mono">{baseBundleId.slice(0, 8)}</span>
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">stack root</div>
      )}
    </div>
  );
}

export const createBundleColumns = (
  depthByBundleId: Record<string, number> = {},
) => [
  columnHelper.accessor("id", {
    header: "Bundle ID",
    cell: (info) => (
      <StackedBundleIdCell
        bundle={info.row.original}
        depth={depthByBundleId[info.getValue()] ?? 0}
      />
    ),
  }),
  columnHelper.accessor("channel", {
    header: "Channel",
    cell: (info) => <ChannelBadge channel={info.getValue()} />,
  }),
  columnHelper.accessor("platform", {
    header: "Platform",
    cell: (info) => (
      <div className="flex items-center gap-2">
        <PlatformIcon platform={info.getValue()} className="h-4 w-4" />
        <span>{info.getValue() === "ios" ? "iOS" : "Android"}</span>
      </div>
    ),
  }),
  columnHelper.display({
    id: "target",
    header: "Target",
    cell: (info) => {
      const row = info.row.original;

      if (row.fingerprintHash) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 cursor-help">
                <Fingerprint className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="font-mono text-xs">
                  {row.fingerprintHash.slice(0, 8)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-mono text-xs">{row.fingerprintHash}</p>
            </TooltipContent>
          </Tooltip>
        );
      }

      if (row.targetAppVersion) {
        return (
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm">{row.targetAppVersion}</span>
          </div>
        );
      }

      return <span className="text-sm text-muted-foreground">-</span>;
    },
  }),
  columnHelper.accessor("enabled", {
    header: "Enabled",
    cell: (info) => <EnabledStatusIcon enabled={info.getValue()} />,
  }),
  columnHelper.accessor("shouldForceUpdate", {
    header: "Force Update",
    cell: (info) => (
      <EnabledStatusIcon enabled={info.getValue()} falseIcon="minus" />
    ),
  }),
  columnHelper.accessor("rolloutCohortCount", {
    header: "Rollout",
    cell: (info) => {
      const rolloutCohortCount =
        info.getValue() ?? DEFAULT_ROLLOUT_COHORT_COUNT;
      const percentage = rolloutCohortCount / 10;

      return <RolloutPercentageBadge percentage={percentage} />;
    },
  }),
  columnHelper.accessor("message", {
    header: "Message",
    cell: (info) => (
      <span className="text-sm text-muted-foreground">
        {info.getValue() || "-"}
      </span>
    ),
  }),
  columnHelper.accessor("id", {
    id: "created",
    header: "Created",
    cell: (info) => <TimestampDisplay uuid={info.getValue()} />,
  }),
];
