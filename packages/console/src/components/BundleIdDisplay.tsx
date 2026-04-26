import { cn } from "@/lib/utils";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

interface BundleIdDisplayProps {
  bundleId: string;
  maxLength?: number;
  className?: string;
  fullOnMobile?: boolean;
}
export function BundleIdDisplay({
  bundleId,
  maxLength = 12,
  className,
  fullOnMobile = false,
}: BundleIdDisplayProps) {
  // UUIDv7: show last characters (more unique) instead of first (timestamp)
  const truncated =
    bundleId.length > maxLength ? bundleId.slice(-maxLength) : bundleId;
  if (bundleId.length <= maxLength) {
    return (
      <span
        translate="no"
        className={cn("font-mono text-xs tabular-nums", className)}
      >
        {bundleId}
      </span>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            translate="no"
            className={cn(
              "font-mono text-xs tabular-nums",
              fullOnMobile
                ? "break-all sm:break-normal sm:cursor-help"
                : "cursor-help",
              className,
            )}
          >
            {fullOnMobile ? (
              <>
                <span className="sm:hidden">{bundleId}</span>
                <span className="hidden sm:inline">{truncated}</span>
              </>
            ) : (
              truncated
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p translate="no" className="font-mono text-xs tabular-nums">
            {bundleId}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
