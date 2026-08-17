import type { ReleaseRow } from "@hot-updater/plugin-core";
import { Check, CircleOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";

export function ReleaseStateBadge({ release }: { release: ReleaseRow }) {
  return (
    <Badge
      className="gap-1 font-normal text-muted-foreground"
      variant={release.enabled ? "outline" : "secondary"}
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
