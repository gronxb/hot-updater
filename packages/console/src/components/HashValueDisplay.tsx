import { toast } from "sonner";

import { cn } from "@/lib/utils";

import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface HashValueDisplayProps {
  value: string;
  maxLength?: number;
  className?: string;
}

export function HashValueDisplay({
  value,
  maxLength = 12,
  className,
}: HashValueDisplayProps) {
  const isTruncated = value.length > maxLength;
  const truncated = isTruncated ? value.slice(0, maxLength) : value;

  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard", {
        description: value,
      });
    } catch {
      toast.error("Failed to copy value");
    }
  };

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void copyValue();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      void copyValue();
    }
  };

  const content = (
    <span
      translate="no"
      className={cn(
        "font-mono text-xs tabular-nums whitespace-nowrap",
        className,
      )}
    >
      {truncated}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          translate="no"
          className={cn(
            "inline-flex min-w-0 max-w-full cursor-pointer align-top outline-none",
            !isTruncated && "cursor-copy",
          )}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
        >
          {content}
        </button>
      </TooltipTrigger>
      <TooltipContent hidden={!isTruncated}>
        <p translate="no" className="break-all font-mono text-xs tabular-nums">
          {value}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
