import type { Bundle } from "@hot-updater/plugin-core";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { getBundleMetrics } from "@/lib/bundleMetrics";
import { cn } from "@/lib/utils";

type BundleMetricsBadgesProps = {
  readonly bundle: Bundle;
  readonly className?: string;
  readonly empty?: ReactNode;
  readonly showLabel?: boolean;
};

export function BundleMetricsBadges({
  bundle,
  className,
  empty = null,
  showLabel = false,
}: BundleMetricsBadgesProps) {
  const metrics = getBundleMetrics(bundle);

  if (!metrics) {
    return empty;
  }

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5 text-xs", className)}
    >
      {showLabel ? (
        <span className="mr-0.5 font-semibold uppercase text-muted-foreground/70">
          Metrics
        </span>
      ) : null}
      <Badge variant="secondary">{metrics.active} ACTIVE</Badge>
      <Badge variant={metrics.recovered > 0 ? "outline" : "secondary"}>
        {metrics.recovered} RECOVERED
      </Badge>
    </div>
  );
}
