import { Check, TriangleAlert } from "lucide-react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  InstallationSearchResult,
  InstallationSearchRow,
} from "@/lib/api";

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
  return (
    <Card className="min-h-0 min-w-0">
      <CardHeader className="p-6 pb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle className="text-sm font-medium">
              <h2>Matching installations</h2>
            </CardTitle>
            <CardDescription>
              Select a row to review its bundle history.
            </CardDescription>
          </div>
          <Badge variant="outline">{results?.pagination.total ?? 0}</Badge>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 p-0">
        {results && results.data.length > 0 ? (
          <ul aria-label="Matching installations" className="divide-y">
            {results.data.map((event) => {
              const currentBundleId = getLastKnownBundleId(event);
              const isSelected = event.installId === selectedInstallId;
              return (
                <li key={event.installId}>
                  <button
                    aria-pressed={isSelected}
                    className="group flex w-full min-w-0 flex-col gap-4 border-l-2 border-transparent px-6 py-5 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 aria-pressed:border-primary aria-pressed:bg-muted/60"
                    onClick={() => onSelect(event.installId)}
                    type="button"
                  >
                    <span className="flex w-full min-w-0 items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {getUserLabel(event)}
                      </span>
                      {isSelected ? (
                        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                          <Check aria-hidden="true" className="size-3.5" />
                          Selected
                        </span>
                      ) : null}
                    </span>
                    <BundleIdDisplay
                      bundleId={event.installId}
                      className="block text-muted-foreground"
                    />
                    <span className="min-w-0">
                      <span className="mb-1 block text-xs text-muted-foreground">
                        Last known bundle
                      </span>
                      {currentBundleId ? (
                        <BundleIdDisplay bundleId={currentBundleId} />
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : error ? (
          <div className="p-5">
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>Installation search unavailable</AlertTitle>
              <AlertDescription>
                {error instanceof Error
                  ? error.message
                  : "Failed to load installations."}
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <div className="p-5 text-sm text-muted-foreground">
            No installations matched that query.
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
