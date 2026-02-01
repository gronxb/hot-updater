import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface EnabledStatusIconProps {
  enabled: boolean;
  className?: string;
}

export function EnabledStatusIcon({
  enabled,
  className,
}: EnabledStatusIconProps) {
  if (enabled) {
    return (
      <Check
        className={cn("h-4 w-4 text-green-600 dark:text-green-400", className)}
      />
    );
  }
  return (
    <X className={cn("h-4 w-4 text-red-600 dark:text-red-400", className)} />
  );
}
