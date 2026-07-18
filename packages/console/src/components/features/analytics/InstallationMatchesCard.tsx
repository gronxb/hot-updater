import { TriangleAlert } from "lucide-react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
      <CardHeader className="p-5 pb-4">
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
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-2/5 whitespace-normal">
                  Installation
                </TableHead>
                <TableHead className="w-1/4 whitespace-normal">
                  User ID
                </TableHead>
                <TableHead className="whitespace-normal">
                  Last known bundle
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.data.map((event) => {
                const currentBundleId = getLastKnownBundleId(event);
                const isSelected = event.installId === selectedInstallId;
                return (
                  <TableRow
                    data-state={isSelected ? "selected" : undefined}
                    key={event.installId}
                  >
                    <TableCell className="whitespace-normal align-top">
                      <Button
                        className="h-auto w-full min-w-0 shrink justify-start whitespace-normal p-0 text-left font-normal focus-visible:ring-2"
                        onClick={() => onSelect(event.installId)}
                        type="button"
                        variant="link"
                      >
                        <BundleIdDisplay bundleId={event.installId} />
                      </Button>
                    </TableCell>
                    <TableCell className="whitespace-normal align-top text-sm">
                      {getUserLabel(event)}
                    </TableCell>
                    <TableCell className="whitespace-normal align-top">
                      {currentBundleId ? (
                        <BundleIdDisplay bundleId={currentBundleId} />
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
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
