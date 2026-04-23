import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

interface BundleIdDisplayProps {
  bundleId: string;
  maxLength?: number;
}
export function BundleIdDisplay({
  bundleId,
  maxLength = 12,
}: BundleIdDisplayProps) {
  // UUIDv7: show last characters (more unique) instead of first (timestamp)
  const truncated =
    bundleId.length > maxLength ? bundleId.slice(-maxLength) : bundleId;
  if (bundleId.length <= maxLength) {
    return (
      <span translate="no" className="font-mono text-xs tabular-nums">
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
            className="cursor-help font-mono text-xs tabular-nums"
          >
            {truncated}
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
