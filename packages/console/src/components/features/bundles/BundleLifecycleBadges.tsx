import type { Bundle } from "@hot-updater/plugin-core";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { getBundleLifecycle } from "@/lib/bundleLifecycle";
import { cn } from "@/lib/utils";

type BundleLifecycleBadgesProps = {
  readonly bundle: Bundle;
  readonly className?: string;
  readonly empty?: ReactNode;
  readonly showLabel?: boolean;
};

export function BundleLifecycleBadges({
  bundle,
  className,
  empty = null,
  showLabel = false,
}: BundleLifecycleBadgesProps) {
  const lifecycle = getBundleLifecycle(bundle);

  if (!lifecycle) {
    return empty;
  }

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5 text-xs", className)}
    >
      {showLabel ? (
        <span className="mr-0.5 font-semibold uppercase text-muted-foreground/70">
          Lifecycle
        </span>
      ) : null}
      <Badge variant="secondary">{lifecycle.active} ACTIVE</Badge>
      <Badge variant={lifecycle.recovered > 0 ? "outline" : "secondary"}>
        {lifecycle.recovered} RECOVERED
      </Badge>
    </div>
  );
}
