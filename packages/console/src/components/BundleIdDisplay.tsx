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
    return <span className="font-mono text-sm">{bundleId}</span>;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="font-mono text-sm cursor-help">{truncated}</span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="font-mono text-xs">{bundleId}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
