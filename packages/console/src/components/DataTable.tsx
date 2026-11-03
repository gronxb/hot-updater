import { Link, type LinkProps } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import type { ComponentProps, MouseEvent, ReactNode } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/*
 * The shell the Bundles and Native builds lists share: a bordered frame that
 * scrolls a column table on wide screens, or a list of cards on narrow ones,
 * with a pagination bar under it. Each page keeps its own columns and cells.
 */

/** The bordered frame; the table or card list inside it scrolls. */
export function DataTableFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm [&_[data-slot=table-container]]:h-full [&_[data-slot=table-container]]:overflow-auto">
      {children}
    </div>
  );
}

/** A table as wide as its columns, with an uppercase header row. */
export function DataTable({
  header,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof Table>, "children"> & {
  /** The header row's cells. */
  readonly header: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Table className={cn("min-w-max", className)} {...props}>
      <TableHeader className="bg-muted/40">
        <TableRow className="border-b border-border/60 hover:bg-transparent [&>th]:h-10 [&>th]:text-xs [&>th]:font-semibold [&>th]:uppercase [&>th]:text-muted-foreground">
          {header}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

/**
 * Opens an item from a click anywhere on its row or card, except on a
 * control inside it, which keeps its own action.
 */
export const openOutsideControls =
  (open: () => void) => (event: MouseEvent<HTMLElement>) => {
    if (
      event.target instanceof Element &&
      event.target.closest("button, a, input, select, textarea")
    ) {
      return;
    }
    open();
  };

/**
 * A row that opens its item: a click outside its controls, or Enter or Space
 * on the focused row, with hover, focus, and selection as one style.
 */
export function DataTableRow({
  className,
  onOpen,
  ...props
}: ComponentProps<typeof TableRow> & {
  /** Opens the row's item. */
  readonly onOpen: () => void;
}) {
  return (
    <TableRow
      onClick={openOutsideControls(onOpen)}
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          (event.key !== "Enter" && event.key !== " ")
        ) {
          return;
        }
        event.preventDefault();
        onOpen();
      }}
      tabIndex={0}
      className={cn(
        "cursor-pointer transition-[background-color,filter] hover:bg-muted/10 focus-within:bg-muted/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none data-[state=selected]:bg-muted/15 [&>td]:py-3",
        className,
      )}
      {...props}
    />
  );
}

/** Placeholder rows while the first page loads. */
export function DataTableSkeletonRows({
  columns,
  label,
}: {
  readonly columns: number;
  /** What loads, for screen readers, such as "Loading native builds". */
  readonly label?: string;
}) {
  return Array.from({ length: 7 }, (_, index) => (
    <TableRow key={index}>
      <TableCell colSpan={columns}>
        {index === 0 && label ? <span className="sr-only">{label}</span> : null}
        <Skeleton className="h-8 w-full" />
      </TableCell>
    </TableRow>
  ));
}

/** A row across every column, for an empty list or an inline message. */
export function DataTableFullRow({
  columns,
  className,
  children,
}: {
  readonly columns: number;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <TableRow>
      <TableCell
        className={cn("h-44 text-center text-muted-foreground", className)}
        colSpan={columns}
      >
        {children}
      </TableCell>
    </TableRow>
  );
}

/**
 * What an empty list says: the page's icon, what is missing, and what to do
 * about it, in a table row or a card list.
 */
export function DataTableEmpty({
  icon: Icon,
  title,
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: ReactNode;
  /** A sentence and the actions that fill the list. */
  readonly children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-2 whitespace-normal text-center text-sm text-muted-foreground">
      <Icon aria-hidden="true" className="size-5" />
      <p className="font-medium text-foreground">{title}</p>
      {children}
    </div>
  );
}

/** The empty card list on a narrow screen. */
export function DataCardsEmpty({ children }: { readonly children: ReactNode }) {
  return <div className="p-8">{children}</div>;
}

/** Placeholder cards while the first page loads on a narrow screen. */
export function DataCardSkeletons({ label }: { readonly label?: string }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      {label ? <span className="sr-only">{label}</span> : null}
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton className="h-44 w-full" key={index} />
      ))}
    </div>
  );
}

/** One item's card on a narrow screen; a tap opens it. */
export function DataCard({ className, ...props }: ComponentProps<"article">) {
  return (
    <article
      className={cn(
        "flex cursor-pointer touch-manipulation flex-col gap-4 border-b p-4 transition-[background-color,filter] last:border-b-0 hover:bg-muted/10 active:bg-muted/20 motion-reduce:transition-none data-[state=selected]:bg-muted/15",
        className,
      )}
      {...props}
    />
  );
}

/** A labelled value of a card, in its two-column grid. */
export function DataCardField({
  label,
  className,
  valueClassName,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly valueClassName?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn("rounded-md bg-muted/40 p-3", className)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1", valueClassName)}>{children}</dd>
    </div>
  );
}

/** A page of a list: the route and the search that shows it. */
export type PageLink = Pick<LinkProps, "to" | "search">;

/**
 * The bar under a list: how many entries show, and Previous and Next, links
 * to the newer and older pages, or disabled at either end. Newest shows on any
 * page but the first.
 */
export function DataTablePagination({
  count,
  label,
  newest,
  previous,
  next,
}: {
  readonly count: number;
  /** The navigation's name, such as "Bundle pagination". */
  readonly label: string;
  /** The first page, when the list shows another. */
  readonly newest?: PageLink;
  /** The newer page, if any. */
  readonly previous?: PageLink;
  /** The older page, if any. */
  readonly next?: PageLink;
}) {
  return (
    <nav
      aria-label={label}
      className="flex flex-col gap-3 px-2 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-xs font-medium text-muted-foreground">
        <span className="text-foreground">{count}</span>{" "}
        {count === 1 ? "entry" : "entries"}, newest first
      </p>
      <div className="flex flex-wrap items-center gap-3 sm:justify-end">
        {newest ? (
          <Link
            className={buttonVariants({
              className: "h-8 flex-1 px-3 text-xs sm:flex-none",
              size: "sm",
              variant: "ghost",
            })}
            search={newest.search}
            to={newest.to}
          >
            Newest
          </Link>
        ) : null}
        {previous ? (
          <Link
            className={buttonVariants({
              className: "h-8 flex-1 px-3 text-xs sm:flex-none",
              size: "sm",
              variant: "outline",
            })}
            search={previous.search}
            to={previous.to}
          >
            <ChevronLeft data-icon="inline-start" />
            Previous
          </Link>
        ) : (
          <Button
            className="h-8 flex-1 px-3 text-xs sm:flex-none"
            disabled
            size="sm"
            variant="outline"
          >
            <ChevronLeft data-icon="inline-start" />
            Previous
          </Button>
        )}
        {next ? (
          <Link
            className={buttonVariants({
              className: "h-8 flex-1 px-3 text-xs sm:flex-none",
              size: "sm",
              variant: "outline",
            })}
            search={next.search}
            to={next.to}
          >
            Next
            <ChevronRight data-icon="inline-end" />
          </Link>
        ) : (
          <Button
            className="h-8 flex-1 px-3 text-xs sm:flex-none"
            disabled
            size="sm"
            variant="outline"
          >
            Next
            <ChevronRight data-icon="inline-end" />
          </Button>
        )}
      </div>
    </nav>
  );
}
