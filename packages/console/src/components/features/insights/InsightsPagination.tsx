import { Button } from "@/components/ui/button";

export function InsightsPagination({
  hasPrevious,
  label,
  nextCursor,
  onNext,
  onPrevious,
  pageLength,
  pageNumber,
}: {
  readonly hasPrevious: boolean;
  readonly label: string;
  readonly nextCursor: string | null;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly pageLength: number;
  readonly pageNumber: number;
}) {
  return (
    <nav
      aria-label={`${label} pagination`}
      className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 sm:px-6"
    >
      <span className="text-xs text-muted-foreground tabular-nums">
        Page {pageNumber} · {pageLength.toLocaleString()} rows
      </span>
      <div className="flex gap-2">
        <Button
          className="h-11 min-w-11 px-3 lg:h-8 lg:min-w-0 lg:px-2"
          disabled={!hasPrevious}
          onClick={onPrevious}
          size="sm"
          type="button"
          variant="outline"
        >
          Previous
        </Button>
        <Button
          className="h-11 min-w-11 px-3 lg:h-8 lg:min-w-0 lg:px-2"
          disabled={nextCursor === null}
          onClick={onNext}
          size="sm"
          type="button"
          variant="outline"
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
