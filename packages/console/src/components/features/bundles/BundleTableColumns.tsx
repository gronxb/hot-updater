import type { Bundle } from "@hot-updater/plugin-core";
import { createColumnHelper } from "@tanstack/react-table";
import { ChevronDown, ChevronRight } from "lucide-react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { HashValueDisplay } from "@/components/HashValueDisplay";
import { PlatformIcon } from "@/components/PlatformIcon";
import { TimestampDisplay } from "@/components/TimestampDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface BundleColumnsOptions {
  expandedBundleId?: string;
  patchCountsByBundleId: Record<string, number | undefined>;
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
          <BundleIdDisplay bundleId={bundle.id} fullOnMobile />
        </span>
      </button>
    </div>
  );
}

export const createBundleColumns = ({
  expandedBundleId,
  patchCountsByBundleId,
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
    id: "patches",
    header: "Patches",
    cell: (info) => {
      const count = patchCountsByBundleId[info.row.original.id];

      if (count === undefined) {
        return <span className="text-sm text-muted-foreground">Checking</span>;
      }

      if (count === 0) {
        return <span className="text-sm text-muted-foreground">-</span>;
      }

      return (
        <Badge variant="secondary">
          {count} {count === 1 ? "patch" : "patches"}
        </Badge>
      );
    },
  }),
  columnHelper.accessor("fileHash", {
    header: "File Hash",
    cell: (info) => <HashValueDisplay value={info.getValue()} maxLength={12} />,
  }),
  columnHelper.accessor("storageUri", {
    header: "Storage",
    cell: (info) => (
      <span
        translate="no"
        className="block max-w-[260px] truncate font-mono text-xs text-muted-foreground"
        title={info.getValue()}
      >
        {info.getValue()}
      </span>
    ),
  }),
  columnHelper.accessor("id", {
    id: "created",
    header: "Created",
    cell: (info) => <TimestampDisplay uuid={info.getValue()} />,
  }),
];
