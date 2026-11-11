import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { DataTableBody } from "@/components/DataTable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import type { Fold, FoldedEntry } from "@/lib/server/foldedPage";

/*
 * A fold of a list's page: the run of rows between two ordinary ones (older
 * native builds, unreachable bundles), shown where the run sits as one row
 * that says how many it holds. Opening it shows exactly those rows in its
 * place, in the list's order, read when it first opens. Each fold opens on
 * its own; the page's own read never changes with them.
 */

/** What one row of a fold is, and many are: "older build", "older builds". */
export interface FoldNoun {
  readonly one: string;
  readonly other: string;
}

/** A fold's key on its page: the row above it, which no other fold shares. */
export const foldKey = (fold: Pick<Fold, "from">) => fold.from ?? "";

/** "1 older build", "12 older builds", "100+ older builds". */
export const foldLabel = (fold: Pick<Fold, "count" | "more">, noun: FoldNoun) =>
  `${fold.count}${fold.more ? "+" : ""} ${
    fold.count === 1 && !fold.more ? noun.one : noun.other
  }`;

/** A page's entries as table row groups: each run of rows, and each fold. */
export const groupsOf = <T extends { readonly id: string }>(
  entries: readonly FoldedEntry<T>[],
) => {
  const groups: (
    | { readonly kind: "rows"; readonly rows: T[] }
    | { readonly kind: "fold"; readonly fold: Fold }
  )[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (entry.kind === "fold") groups.push({ kind: "fold", fold: entry });
    else if (last?.kind === "rows") last.rows.push(entry.row);
    else groups.push({ kind: "rows", rows: [entry.row] });
  }
  return groups;
};

/** Which folds of a page are open, by `foldKey`. */
export function useOpenFolds() {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  return {
    isOpen: (key: string) => open.has(key),
    set: (key: string, value: boolean) =>
      setOpen((previous) => {
        if (previous.has(key) === value) return previous;
        const next = new Set(previous);
        if (value) next.add(key);
        else next.delete(key);
        return next;
      }),
  };
}

export interface FoldProps {
  readonly label: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The ID of the group that holds the fold's rows, which it opens. */
  readonly panelId: string;
  /** The fold's rows while open, with `FoldStatus` while they load. */
  readonly children: ReactNode;
}

/**
 * The fold's button: a chevron and "12 older builds", as tall as a touch
 * needs on a phone and as a row's text on a wide screen.
 */
function FoldButton({
  label,
  open,
  onOpenChange,
  panelId,
}: Omit<FoldProps, "children">) {
  return (
    <button
      aria-controls={panelId}
      aria-expanded={open}
      className="group/fold flex min-h-11 w-full items-center gap-2 px-4 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset motion-reduce:transition-none sm:min-h-9 sm:px-3"
      onClick={() => onOpenChange(!open)}
      type="button"
    >
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 shrink-0 transition-transform group-aria-expanded/fold:rotate-90 motion-reduce:transition-none"
      />
      {label}
    </button>
  );
}

/** A fold in a `rowGroups` table: its row, then the group of its rows. */
export function DataTableFold({
  columns,
  children,
  ...props
}: FoldProps & { readonly columns: number }) {
  return (
    <>
      <DataTableBody>
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell className="p-0" colSpan={columns}>
            <FoldButton {...props} />
          </TableCell>
        </TableRow>
      </DataTableBody>
      <DataTableBody hidden={!props.open} id={props.panelId}>
        {props.open ? children : null}
      </DataTableBody>
    </>
  );
}

/**
 * A fold in a list of cards on a narrow screen; `inList` when the cards are
 * a list's items, so its row is one too.
 */
export function DataCardFold({
  children,
  inList = false,
  ...props
}: FoldProps & { readonly inList?: boolean }) {
  return (
    <>
      <div
        className="border-b bg-muted/20"
        role={inList ? "listitem" : undefined}
      >
        <FoldButton {...props} />
      </div>
      <div hidden={!props.open} id={props.panelId}>
        {props.open ? children : null}
      </div>
    </>
  );
}

/**
 * What an open fold shows past its rows: that they load, that more of them
 * load on request, or that they couldn't be read.
 */
export function FoldStatus({
  state,
  label,
  onMore,
  onRetry,
  columns,
}: {
  readonly state: "loading" | "more" | "error";
  /** What loads, for screen readers, such as "Loading older builds". */
  readonly label: string;
  readonly onMore?: () => void;
  readonly onRetry?: () => void;
  /** Set in a table, to span its columns. */
  readonly columns?: number;
}) {
  const body =
    state === "loading" ? (
      <div aria-live="polite" className="flex flex-col gap-2 p-3">
        <span className="sr-only">{label}</span>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    ) : (
      <div className="flex items-center gap-3 px-4 py-2 sm:px-3">
        {state === "error" ? (
          <span className="text-xs text-muted-foreground" role="status">
            These rows couldn't be loaded.
          </span>
        ) : null}
        <Button
          className="h-11 px-3 text-xs sm:h-8"
          onClick={state === "error" ? onRetry : onMore}
          size="sm"
          variant="ghost"
        >
          {state === "error" ? "Retry" : "Show more"}
        </Button>
      </div>
    );
  return columns === undefined ? (
    <div className="border-b">{body}</div>
  ) : (
    <TableRow className="hover:bg-transparent">
      <TableCell className="p-0" colSpan={columns}>
        {body}
      </TableCell>
    </TableRow>
  );
}
