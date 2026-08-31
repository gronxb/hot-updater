import { toast } from "sonner";

import { cn } from "@/lib/utils";

import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface HashValueDisplayProps {
  value: string;
  maxLength?: number;
  className?: string;
  buttonClassName?: string;
}

export const shortenIdentifier = (value: string, maxLength = 12) =>
  value.length > maxLength
    ? `${value.slice(0, Math.max(1, maxLength - 4))}…${value.slice(-4)}`
    : value;

export function HashValueDisplay({
  value,
  maxLength = 12,
  className,
  buttonClassName,
}: HashValueDisplayProps) {
  const isTruncated = value.length > maxLength;
  const truncated = shortenIdentifier(value, maxLength);

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
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Copy full value: ${value}`}
            translate="no"
            className={cn(
              "ring-ring/30 bg-muted/40 border-border/70 inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-md border px-1.5 py-0.5 align-top shadow-xs outline-none transition-[background-color,border-color,transform,box-shadow]",
              "hover:bg-muted/70 active:scale-[0.98] active:bg-muted/85 focus-visible:ring-[2px]",
              "touch-manipulation select-none motion-reduce:transition-none motion-reduce:active:scale-100",
              !isTruncated && "cursor-copy",
              buttonClassName,
            )}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
          />
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipContent hidden={!isTruncated}>
        <p translate="no" className="break-all font-mono text-xs tabular-nums">
          {value}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
