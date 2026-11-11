import type { LucideIcon } from "lucide-react";
import { useId, useState } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * A quiet word on a row a list shades, such as "Older" or "Unreachable",
 * that says why on a tap, a click, or focus: a touch or a keyboard reaches
 * the reason, not only a pointer's hover. A control of its own, so it opens
 * no row.
 */
export function RowReason({
  icon: Icon,
  children,
  label,
  reason,
}: {
  readonly icon: LucideIcon;
  /** The word the row shows. */
  readonly children: string;
  /** The word and its reason, as a screen reader names the control. */
  readonly label: string;
  /** The reason, as its tooltip says it. */
  readonly reason: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <Tooltip onOpenChange={setOpen} open={open} triggerId={id}>
      <TooltipTrigger
        aria-describedby={open ? `${id}-reason` : undefined}
        aria-label={label}
        className="relative inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors after:absolute after:-inset-x-2 after:-inset-y-3.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none sm:after:hidden"
        closeOnClick={false}
        id={id}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Icon aria-hidden="true" className="size-3.5" />
        {children}
      </TooltipTrigger>
      <TooltipContent
        className="max-w-64"
        id={`${id}-reason`}
        role="tooltip"
        side="bottom"
      >
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}
