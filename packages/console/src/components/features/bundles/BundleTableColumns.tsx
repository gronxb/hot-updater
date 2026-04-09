import { DEFAULT_ROLLOUT_COHORT_COUNT } from "@hot-updater/core";
import type { Bundle } from "@hot-updater/plugin-core";
import { createColumnHelper } from "@tanstack/react-table";
import { ChevronDown, ChevronRight, Fingerprint, Package } from "lucide-react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
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

const isPatchReady = (bundle: Bundle) =>
  bundle.metadata?.hbc_patch_algorithm === "bsdiff" &&
  Boolean(bundle.metadata?.hbc_patch_storage_uri);

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
  const summary =
    bundle.message?.trim() ||
    bundle.targetAppVersion ||
    (bundle.fingerprintHash
      ? `Fingerprint ${bundle.fingerprintHash.slice(0, 8)}`
      : `${bundle.channel} channel`);
  const panelId = `bundle-lineage-panel-${bundle.id}`;

  return (
    <div className="flex min-w-[280px] items-start gap-3">
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
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <BundleIdDisplay bundleId={bundle.id} />
          {hasDiffBase ? <Badge variant="secondary">Patch</Badge> : null}
        </div>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {summary}
        </span>
      </div>
    </div>
  );
}

function DiffBaseCell({ bundle, depth }: { bundle: Bundle; depth: number }) {
  const baseBundleId = bundle.metadata?.diff_base_bundle_id;
  const patchReady = isPatchReady(bundle);

  if (!baseBundleId) {
    return (
      <div className="flex min-w-[220px] flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Root</Badge>
        </div>
        <span className="text-xs text-muted-foreground">
          No diff base attached.
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-w-[220px] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">Derived</Badge>
        {patchReady ? (
          <Badge variant="secondary">BSDIFF Ready</Badge>
        ) : (
          <Badge variant="outline">Base Linked</Badge>
        )}
        {depth > 1 ? <Badge variant="outline">L{depth}</Badge> : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span>From</span>
        <BundleIdDisplay bundleId={baseBundleId} maxLength={18} />
      </div>
    </div>
  );
}

function StatusCell({ bundle }: { bundle: Bundle }) {
  const patchReady = isPatchReady(bundle);

  return (
    <div className="flex min-w-[220px] flex-wrap gap-1.5">
      <Badge variant={bundle.enabled ? "default" : "outline"}>
        {bundle.enabled ? "Enabled" : "Disabled"}
      </Badge>
      <Badge variant={bundle.shouldForceUpdate ? "secondary" : "outline"}>
        {bundle.shouldForceUpdate ? "Force Update" : "Optional"}
      </Badge>
      {patchReady ? <Badge variant="secondary">Hermes BSDIFF</Badge> : null}
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
    header: "Lineage",
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
  columnHelper.display({
    id: "status",
    header: "Status",
    cell: (info) => <StatusCell bundle={info.row.original} />,
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
