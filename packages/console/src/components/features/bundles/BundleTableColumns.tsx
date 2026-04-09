import { DEFAULT_ROLLOUT_COHORT_COUNT } from "@hot-updater/core";
import type { Bundle } from "@hot-updater/plugin-core";
import { createColumnHelper } from "@tanstack/react-table";
import { ChevronDown, ChevronRight, Fingerprint, Package } from "lucide-react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import { EnabledStatusIcon } from "@/components/EnabledStatusIcon";
import { PlatformIcon } from "@/components/PlatformIcon";
import { RolloutPercentageBadge } from "@/components/RolloutPercentageBadge";
import { TimestampDisplay } from "@/components/TimestampDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface BundleColumnsOptions {
  depthByBundleId?: Record<string, number>;
  expandedBundleId?: string;
  onDetailClick: (bundle: Bundle) => void;
  onToggleExpand: (bundle: Bundle) => void;
}

const columnHelper = createColumnHelper<Bundle>();

function BundleIdCell({
  bundle,
  expandedBundleId,
  onToggleExpand,
}: {
  bundle: Bundle;
  expandedBundleId?: string;
  onToggleExpand: (bundle: Bundle) => void;
}) {
  const hasDiffBase = Boolean(bundle.metadata?.diff_base_bundle_id);
  const isExpanded = bundle.id === expandedBundleId;

  return (
    <div className="flex min-w-[240px] items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 touch-manipulation"
        aria-label={isExpanded ? "Hide Patch Bundles" : "Show Patch Bundles"}
        onClick={(event) => {
          event.stopPropagation();
          onToggleExpand(bundle);
        }}
      >
        {isExpanded ? (
          <ChevronDown aria-hidden="true" />
        ) : (
          <ChevronRight aria-hidden="true" />
        )}
      </Button>
      <BundleIdDisplay bundleId={bundle.id} />
      {hasDiffBase ? <Badge variant="secondary">Patch</Badge> : null}
    </div>
  );
}

function DiffBaseCell({ bundle, depth }: { bundle: Bundle; depth: number }) {
  const baseBundleId = bundle.metadata?.diff_base_bundle_id;

  if (!baseBundleId) {
    return <Badge variant="outline">Root</Badge>;
  }

  return (
    <div className="flex min-w-[180px] items-center gap-2">
      <BundleIdDisplay bundleId={baseBundleId} maxLength={18} />
      {depth > 1 ? <Badge variant="outline">L{depth}</Badge> : null}
    </div>
  );
}

export const createBundleColumns = ({
  depthByBundleId = {},
  expandedBundleId,
  onDetailClick,
  onToggleExpand,
}: BundleColumnsOptions) => [
  columnHelper.accessor("id", {
    header: "Bundle ID",
    cell: (info) => (
      <BundleIdCell
        bundle={info.row.original}
        expandedBundleId={expandedBundleId}
        onToggleExpand={onToggleExpand}
      />
    ),
  }),
  columnHelper.display({
    id: "diffBase",
    header: "Diff Base",
    cell: (info) => (
      <DiffBaseCell
        bundle={info.row.original}
        depth={depthByBundleId[info.row.original.id] ?? 0}
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
  columnHelper.display({
    id: "detail",
    header: "Detail",
    cell: (info) => (
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="touch-manipulation"
          onClick={(event) => {
            event.stopPropagation();
            onDetailClick(info.row.original);
          }}
        >
          Detail
        </Button>
      </div>
    ),
  }),
];
