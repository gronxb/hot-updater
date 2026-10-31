import { toast } from "sonner";

/**
 * A hash shortened to its prefix, as git shows a commit: never cut in the
 * middle, the full value on hover, and copied on click.
 */
export function ShortHash({
  value,
  length,
  label,
}: {
  readonly value: string;
  /** How many leading characters show, such as 7 for a commit. */
  readonly length: number;
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
      className="cursor-copy rounded-sm font-mono text-xs whitespace-nowrap tabular-nums underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
      title={value}
      translate="no"
      type="button"
    >
      {value.slice(0, length)}
    </button>
  );
}
