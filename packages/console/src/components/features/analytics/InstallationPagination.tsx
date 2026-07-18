import { Button } from "@/components/ui/button";

export function InstallationPagination({
  label,
  limit,
  offset,
  pageLength,
  total,
  onOffsetChange,
}: {
  readonly label: string;
  readonly limit: number;
  readonly offset: number;
  readonly pageLength: number;
  readonly total: number;
  readonly onOffsetChange: (offset: number) => void;
}) {
  return (
    <nav
      aria-label={`${label} pagination`}
      className="flex items-center justify-between gap-3 border-t px-4 py-3"
    >
      <span className="text-xs text-muted-foreground">
        {offset + 1}–{Math.min(offset + pageLength, total)} of {total}
      </span>
      <div className="flex gap-2">
        <Button
          disabled={offset === 0}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
          size="sm"
          type="button"
          variant="outline"
        >
          Previous
        </Button>
        <Button
          disabled={offset + pageLength >= total}
          onClick={() => onOffsetChange(offset + limit)}
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
