import { ChevronRight } from "lucide-react";

import { TableCell, TableRow } from "@/components/ui/table";

/*
 * The group a list collapses rows into, under its other rows: the Native
 * builds passed over on their path, and the Bundles no device gets. One
 * button says how many rows of the page it holds and opens them below it;
 * the page keeps whether it is open in its URL.
 */

export interface CollapsedRowsProps {
  /** How many rows of the page the group holds. */
  readonly count: number;
  /** What one row is and many are, such as "older build" and "older builds". */
  readonly noun: { readonly one: string; readonly other: string };
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The group's button: a chevron and "2 older builds", as tall as a touch
 * needs on a phone and as a row's text on a wide screen.
 */
function CollapsedRowsButton({
  count,
  noun,
  open,
  onOpenChange,
}: CollapsedRowsProps) {
  return (
    <button
      aria-expanded={open}
      className="group/collapsed flex min-h-11 w-full items-center gap-2 px-4 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset motion-reduce:transition-none sm:min-h-9 sm:px-3"
      onClick={() => onOpenChange(!open)}
      type="button"
    >
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 shrink-0 transition-transform group-aria-expanded/collapsed:rotate-90 motion-reduce:transition-none"
      />
      <span>
        <span className="tabular-nums text-foreground">{count}</span>{" "}
        {count === 1 ? noun.one : noun.other}{" "}
        <span className="sr-only">on this page</span>
      </span>
    </button>
  );
}

/** The group as a table row across every column. */
export function DataTableCollapsedRows({
  columns,
  ...props
}: CollapsedRowsProps & { readonly columns: number }) {
  return (
    <TableRow className="bg-muted/20 hover:bg-muted/20">
      <TableCell className="p-0" colSpan={columns}>
        <CollapsedRowsButton {...props} />
      </TableCell>
    </TableRow>
  );
}

/** The group in a list of cards on a narrow screen. */
export function DataCardCollapsedRows(props: CollapsedRowsProps) {
  return (
    <div className="border-b bg-muted/20">
      <CollapsedRowsButton {...props} />
    </div>
  );
}
