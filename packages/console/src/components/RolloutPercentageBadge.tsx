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

  return (
    <Badge
      className={cn("gap-1", className)}
      variant={isPartialRollout ? "secondary" : "default"}
    >
      {isPartialRollout ? <AlertTriangle className="h-3 w-3" /> : null}
      {formattedPercentage}%
    </Badge>
  );
}
