import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";

import { Badge } from "./ui/badge";

interface RolloutPercentageBadgeProps {
  percentage: number;
  className?: string;
}

export function RolloutPercentageBadge({
  percentage,
  className,
}: RolloutPercentageBadgeProps) {
  const isPartialRollout = percentage < 100;
  const formattedPercentage = percentage.toFixed(1);

  if (!isPartialRollout) {
    return (
      <span
        className={cn("text-xs tabular-nums text-muted-foreground", className)}
      >
        {formattedPercentage}%
      </span>
    );
  }

  return (
    <Badge variant="secondary" className={cn("gap-1 font-normal", className)}>
      <AlertTriangle className="h-3 w-3" />
      {formattedPercentage}%
    </Badge>
  );
}
