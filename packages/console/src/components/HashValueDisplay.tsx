import { cn } from "@/lib/utils";

import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface HashValueDisplayProps {
  value: string;
  maxLength?: number;
  className?: string;
  fullOnMobile?: boolean;
}

export function HashValueDisplay({
  value,
  maxLength = 12,
  className,
  fullOnMobile = false,
}: HashValueDisplayProps) {
  const isTruncated = value.length > maxLength;
  const truncated = isTruncated ? `${value.slice(0, maxLength)}...` : value;

  const content = (
    <span
      translate="no"
      className={cn(
        "font-mono text-xs tabular-nums",
        fullOnMobile ? "break-all sm:break-normal" : "break-all",
        className,
      )}
    >
      {fullOnMobile && isTruncated ? (
        <>
          <span className="sm:hidden">{value}</span>
          <span className="hidden sm:inline">{truncated}</span>
        </>
      ) : (
        truncated
      )}
    </span>
  );

  if (!isTruncated) {
    return content;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex min-w-0 max-w-full align-top",
            fullOnMobile ? "sm:cursor-help" : "cursor-help",
          )}
        >
          {content}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p translate="no" className="break-all font-mono text-xs tabular-nums">
          {value}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
