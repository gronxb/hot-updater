import { Badge } from "./ui/badge";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface RolloutPercentageBadgeProps {
  percentage: number;
  className?: string;
}

export function RolloutPercentageBadge({
  percentage,
  className,
}: RolloutPercentageBadgeProps) {
  const isPartialRollout = percentage < 100;

  return (
    <Badge
      variant={isPartialRollout ? "secondary" : "default"}
      className={cn("gap-1", className)}
    >
      {isPartialRollout && <AlertTriangle className="h-3 w-3" />}
      {percentage}%
    </Badge>
  );
}
