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
  maxLength = 8,
}: BundleIdDisplayProps) {
  const truncated =
    bundleId.length > maxLength
      ? `${bundleId.slice(0, maxLength)}...`
      : bundleId;

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
