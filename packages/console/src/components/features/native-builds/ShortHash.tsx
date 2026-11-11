import { toast } from "sonner";

/**
 * A hash shortened to its prefix, as git shows a commit: never cut in the
 * middle, the full value on hover, and copied on click.
 */
export function ShortHash({
  value,
  length,
  shown = value.slice(0, length),
  label,
}: {
  readonly value: string;
  /** How many leading characters show, such as 7 for a commit. */
  readonly length?: number;
  /** What shows in place of the prefix, such as a masked UDID. */
  readonly shown?: string;
  /** What the value is, for the copy button, such as "commit". */
  readonly label: string;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard", { description: value });
    } catch {
      toast.error(`Could not copy the ${label}`);
    }
  };
  return (
    <button
      aria-label={`Copy the ${label} ${value}`}
      className="relative cursor-copy rounded-sm font-mono after:absolute after:-inset-x-2 after:-inset-y-4 sm:after:hidden text-xs whitespace-nowrap tabular-nums underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
      title={value}
      translate="no"
      type="button"
    >
      {shown}
    </button>
  );
}
