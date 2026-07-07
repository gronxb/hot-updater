import { Check, Minus, X } from "lucide-react";

import { cn } from "@/lib/utils";

interface EnabledStatusIconProps {
  enabled: boolean;
  className?: string;
  falseIcon?: "minus" | "x";
  colorMode?: "semantic" | "inherit";
}

export function EnabledStatusIcon({
  enabled,
  className,
  falseIcon = "x",
  colorMode = "semantic",
}: EnabledStatusIconProps) {
  const iconColorClassName =
    colorMode === "inherit" ? "text-current" : undefined;

  if (enabled) {
    return (
      <Check
        className={cn(
          "h-4 w-4",
          iconColorClassName ?? "text-green-600 dark:text-green-400",
          className,
        )}
      />
    );
  }

  if (falseIcon === "minus") {
    return (
      <Minus
        className={cn(
          "h-4 w-4",
          iconColorClassName ?? "text-muted-foreground",
          className,
        )}
      />
    );
  }

  return (
    <X
      className={cn(
        "h-4 w-4",
        iconColorClassName ?? "text-red-600 dark:text-red-400",
        className,
      )}
    />
  );
}
