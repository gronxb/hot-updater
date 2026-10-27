import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/** A command or link on one line, with a button that copies it. */
export function CopyableText({
  label,
  value,
}: {
  /** What the copy button copies, such as "the install command". */
  readonly label: string;
  readonly value: string;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error(`Could not copy ${label}`);
    }
  };
  return (
    <div className="flex w-full min-w-0 items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto text-left font-mono text-xs whitespace-nowrap">
        {value}
      </code>
      <Button
        aria-label={`Copy ${label}`}
        className="size-11 sm:size-7"
        onClick={() => void copy()}
        size="icon-sm"
        variant="ghost"
      >
        <Copy aria-hidden="true" />
      </Button>
    </div>
  );
}
