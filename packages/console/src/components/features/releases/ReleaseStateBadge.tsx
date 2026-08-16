import type { ReleaseRow } from "@hot-updater/plugin-core";
import { Check, CircleOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function ReleaseStateBadge({ release }: { release: ReleaseRow }) {
  return (
    <Badge
      className={cn(
        "gap-1 border-0",
        release.enabled
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground",
      )}
      variant="secondary"
    >
      {release.enabled ? (
        <Check className="size-3" />
      ) : (
        <CircleOff className="size-3" />
      )}
      {release.enabled ? "Enabled" : "Disabled"}
    </Badge>
  );
}
