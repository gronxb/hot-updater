import type { Bundle } from "@hot-updater/plugin-core";
import { createColumnHelper } from "@tanstack/react-table";
import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import { EnabledStatusIcon } from "@/components/EnabledStatusIcon";
import { PlatformIcon } from "@/components/PlatformIcon";
import { RolloutPercentageBadge } from "@/components/RolloutPercentageBadge";
import { TimestampDisplay } from "@/components/TimestampDisplay";

const columnHelper = createColumnHelper<Bundle>();

export const bundleColumns = [
  columnHelper.accessor("id", {
    header: "Bundle ID",
    cell: (info) => <BundleIdDisplay bundleId={info.getValue()} />,
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
      return (
        <div className="flex flex-col gap-1">
          {row.targetAppVersion && (
            <span className="text-sm">{row.targetAppVersion}</span>
          )}
          {row.fingerprintHash && (
            <span className="text-xs text-muted-foreground font-mono">
              {row.fingerprintHash.slice(0, 8)}...
            </span>
          )}
        </div>
      );
    },
  }),
  columnHelper.accessor("enabled", {
    header: "Enabled",
    cell: (info) => <EnabledStatusIcon enabled={info.getValue()} />,
  }),
  columnHelper.accessor("shouldForceUpdate", {
    header: "Force Update",
    cell: (info) => <EnabledStatusIcon enabled={info.getValue()} />,
  }),
  columnHelper.accessor("rolloutPercentage", {
    header: "Rollout",
    cell: (info) => {
      const percentage = info.getValue() ?? 100;
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
