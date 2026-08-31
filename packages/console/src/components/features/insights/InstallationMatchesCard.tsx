import { Check, ChevronDown } from "lucide-react";
import { useId, useRef, useState } from "react";

import { shortenIdentifier } from "@/components/HashValueDisplay";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  InstallationSearchResult,
  InstallationSearchRow,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { InsightsErrorAlert } from "./InsightsErrorAlert";
import { InstallationPagination } from "./InstallationPagination";

const getLastKnownBundleId = (event: InstallationSearchRow) =>
  event.lastKnownBundleId;

const getUserLabel = (event: InstallationSearchRow) =>
  event.userId ?? event.username ?? "—";

export function InstallationMatchesCard({
  error,
  limit,
  offset,
  onOffsetChange,
  onSelect,
  results,
  selectedInstallId,
}: {
  readonly error: unknown;
  readonly limit: number;
  readonly offset: number;
  readonly onOffsetChange: (offset: number) => void;
  readonly onSelect: (installId: string) => void;
  readonly results: InstallationSearchResult | undefined;
  readonly selectedInstallId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const canCollapse = !error && results && results.data.length > 0;

  return (
    <Card className="min-h-0 min-w-0 shadow-sm">
      <CardHeader className="p-4 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle className="text-sm font-medium">
              <h2>Matching installations</h2>
            </CardTitle>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {results && !error ? (
              <Badge variant="secondary" className="tabular-nums">
                {results.pagination.total.toLocaleString()}
              </Badge>
            ) : null}
            {canCollapse ? (
              <Button
                aria-controls={contentId}
                aria-expanded={expanded}
                aria-label={
                  expanded
                    ? "Hide matching installations"
                    : "Show matching installations"
                }
                className="size-11 lg:hidden"
                onClick={() => setExpanded(!expanded)}
                ref={triggerRef}
                size="icon-lg"
                variant="ghost"
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn(expanded && "rotate-180")}
                />
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent
        className={cn(
          "min-h-0 p-0",
          canCollapse && !expanded && "hidden lg:block",
        )}
        id={contentId}
      >
        {error ? (
          <div className="p-6">
            <InsightsErrorAlert
              error={error instanceof Error ? error : new Error()}
              fallbackTitle="Installation search unavailable"
            />
          </div>
        ) : results && results.data.length > 0 ? (
          <ul aria-label="Matching installations" className="divide-y">
            {results.data.map((event) => {
              const currentBundleId = getLastKnownBundleId(event);
              const isSelected = event.installId === selectedInstallId;
              return (
                <li key={event.installId}>
                  <button
                    aria-label={`${getUserLabel(event)}, install ID ${event.installId}`}
                    aria-pressed={isSelected}
                    className="group flex w-full min-w-0 flex-col gap-2 border-l-2 border-transparent px-4 py-4 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 aria-pressed:border-primary aria-pressed:bg-muted/60 motion-reduce:transition-none sm:px-6"
                    onClick={() => {
                      onSelect(event.installId);
                      setExpanded(false);
                      triggerRef.current?.focus();
                    }}
                    type="button"
                  >
                    <span className="flex w-full min-w-0 items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {getUserLabel(event)}
                      </span>
                      {isSelected ? (
                        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                          <Check aria-hidden="true" className="size-3.5" />
                          <span className="sr-only">Selected</span>
                        </span>
                      ) : null}
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <span
                        className="font-mono text-xs"
                        title={event.installId}
                      >
                        {shortenIdentifier(event.installId)}
                      </span>
                    </span>
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Bundle
                      </span>
                      {currentBundleId ? (
                        <span
                          className="font-mono text-xs"
                          title={currentBundleId}
                        >
                          {shortenIdentifier(currentBundleId)}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:px-6">
            <p className="text-sm text-muted-foreground">No matches</p>
            <a
              className={buttonVariants({
                variant: "outline",
                className: "h-11 px-3 lg:h-8",
              })}
              href="#installation-history-search"
            >
              Edit search
            </a>
          </div>
        )}
        {results && results.pagination.total > 0 ? (
          <InstallationPagination
            label="Installation results"
            limit={limit}
            offset={offset}
            pageLength={results.data.length}
            total={results.pagination.total}
            onOffsetChange={onOffsetChange}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
