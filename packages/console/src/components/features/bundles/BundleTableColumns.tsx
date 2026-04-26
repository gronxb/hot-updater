import { DEFAULT_ROLLOUT_COHORT_COUNT } from "@hot-updater/core";
import type { Bundle } from "@hot-updater/plugin-core";
import { createColumnHelper } from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronRight,
  Fingerprint,
  Package,
  PanelRightOpen,
} from "lucide-react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import { EnabledStatusIcon } from "@/components/EnabledStatusIcon";
import { PlatformIcon } from "@/components/PlatformIcon";
import { RolloutPercentageBadge } from "@/components/RolloutPercentageBadge";
import { TimestampDisplay } from "@/components/TimestampDisplay";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface BundleColumnsOptions {
  expandedBundleId?: string;
  onDetailClick: (bundle: Bundle) => void;
  onToggleExpand: (bundle: Bundle) => void;
}

const columnHelper = createColumnHelper<Bundle>();

function BundleIdCell({
  bundle,
  expandedBundleId,
  onDetailClick,
  onToggleExpand,
}: {
  bundle: Bundle;
  expandedBundleId?: string;
  onDetailClick: (bundle: Bundle) => void;
  onToggleExpand: (bundle: Bundle) => void;
}) {
  const isExpanded = bundle.id === expandedBundleId;
  const panelId = `bundle-lineage-panel-${bundle.id}`;

  return (
    <div className="flex min-w-[240px] items-center gap-3">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 touch-manipulation"
        aria-label={isExpanded ? "Hide Lineage" : "Show Lineage"}
        aria-controls={panelId}
        aria-expanded={isExpanded}
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
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-col items-start rounded-sm text-left transition-colors",
          "focus-visible:ring-ring/30 focus-visible:ring-[2px] outline-none",
          "text-muted-foreground hover:text-foreground",
        )}
        aria-label={`Open details for bundle ${bundle.id}`}
        onClick={(event) => {
          event.stopPropagation();
          onDetailClick(bundle);
        }}
      >
        <span className="min-w-0 text-foreground">
          <BundleIdDisplay bundleId={bundle.id} />
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] font-medium">
          Open details
          <PanelRightOpen className="h-3 w-3" />
        </span>
      </button>
    </div>
  );
}

export const createBundleColumns = ({
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
        onDetailClick={onDetailClick}
        onToggleExpand={onToggleExpand}
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
                <span translate="no" className="font-mono text-xs">
                  {row.fingerprintHash.slice(0, 8)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p translate="no" className="font-mono text-xs">
                {row.fingerprintHash}
              </p>
            </TooltipContent>
          </Tooltip>
        );
      }

      if (row.targetAppVersion) {
        return (
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span translate="no" className="text-sm">
              {row.targetAppVersion}
            </span>
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
