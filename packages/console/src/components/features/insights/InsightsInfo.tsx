import { InfoIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function InsightsInfo({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen} triggerId={id}>
      <TooltipTrigger
        id={id}
        aria-describedby={open ? `${id}-description` : undefined}
        closeOnClick={false}
        onClick={() => setOpen((value) => !value)}
        render={
          <Button
            aria-label={label}
            className="size-11 sm:size-7"
            size="icon"
            variant="ghost"
          />
        }
      >
        <InfoIcon />
      </TooltipTrigger>
      <TooltipContent
        id={`${id}-description`}
        role="tooltip"
        className="max-w-64"
        side="bottom"
      >
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
