import { TriangleAlert } from "lucide-react";

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
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  InstallationHistoryResult,
  InstallationHistoryRow,
  InstallationSearchRow,
} from "@/lib/api";

import { InstallationPagination } from "./InstallationPagination";

const formatDateTime = (value: string | number | Date | null | undefined) => {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
};

const getUserLabel = (event: {
  readonly username: string | null;
  readonly userId: string | null;
}) => event.userId ?? event.username ?? "—";

const getLastKnownBundleId = (
  event: InstallationHistoryRow | InstallationSearchRow,
) =>
  "lastKnownBundleId" in event
    ? event.lastKnownBundleId
    : (event.toBundleId ?? event.fromBundleId);

export function InstallationHistoryCard({
  error,
  history,
  isLoading,
  limit,
  offset,
  onOffsetChange,
  selectedEvent,
  selectedInstallId,
}: {
  readonly error: unknown;
  readonly history: InstallationHistoryResult | undefined;
  readonly isLoading: boolean;
  readonly limit: number;
  readonly offset: number;
  readonly onOffsetChange: (offset: number) => void;
  readonly selectedEvent:
    | InstallationHistoryRow
    | InstallationSearchRow
    | undefined;
  readonly selectedInstallId: string;
}) {
  const lastKnownBundleId = selectedEvent
    ? getLastKnownBundleId(selectedEvent)
    : undefined;

  return (
    <Card className="min-h-0 min-w-0">
      <CardHeader className="p-6 pb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle className="text-sm font-medium">
              <h2>
                {selectedInstallId
                  ? "Installation history"
                  : "Select an installation"}
              </h2>
            </CardTitle>
            <CardDescription>
              {selectedInstallId
                ? "Recorded bundle changes for this installation."
                : "Choose a match to view its recorded bundle changes."}
            </CardDescription>
          </div>
          {history && history.pagination.total > 0 ? (
            <Badge variant="outline">{history.pagination.total} events</Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="min-h-0 p-0">
        {selectedInstallId ? (
          isLoading ? (
            <div className="flex flex-col gap-3 p-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : history && history.data.length > 0 ? (
            <>
              <section
                aria-labelledby="latest-installation-state"
                className="px-6 pb-6"
              >
                <h3
                  className="text-xs font-medium"
                  id="latest-installation-state"
                >
                  Latest reported state
                </h3>
                <dl className="mt-4 grid gap-6 xl:grid-cols-3">
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">
                      Installation
                    </dt>
                    <dd className="mt-1 font-mono text-xs">
                      <BundleIdDisplay bundleId={selectedInstallId} />
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">User ID</dt>
                    <dd className="mt-1 truncate text-xs font-medium">
                      {selectedEvent ? getUserLabel(selectedEvent) : "—"}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">
                      Last known bundle
                    </dt>
                    <dd className="mt-1 font-mono text-xs">
                      {lastKnownBundleId ? (
                        <BundleIdDisplay bundleId={lastKnownBundleId} />
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                </dl>
              </section>
              <Separator />
              <Table className="min-w-3xl table-fixed">
                <TableHeader>
                  <TableRow className="hover:bg-transparent [&>th]:h-12 [&>th]:px-5">
                    <TableHead className="w-1/5 whitespace-normal">
                      Reported (UTC)
                    </TableHead>
                    <TableHead className="w-1/6 whitespace-normal">
                      App version
                    </TableHead>
                    <TableHead className="w-1/5 whitespace-normal">
                      Change
                    </TableHead>
                    <TableHead className="whitespace-normal">
                      Bundle transition
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.data.map((event) => (
                    <TableRow
                      className="[&>td]:px-5 [&>td]:py-4"
                      key={event.id}
                    >
                      <TableCell className="whitespace-normal align-top text-sm text-muted-foreground">
                        {formatDateTime(event.receivedAtMs)}
                      </TableCell>
                      <TableCell className="whitespace-normal align-top font-mono text-xs">
                        {event.appVersion}
                      </TableCell>
                      <TableCell className="whitespace-normal align-top">
                        <Badge variant="secondary">
                          {event.type === "UPDATE_APPLIED"
                            ? "Bundle applied"
                            : "Recovered"}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-normal align-top">
                        <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-3">
                          <span className="text-muted-foreground">From</span>
                          <BundleIdDisplay bundleId={event.fromBundleId} />
                          <span className="text-muted-foreground">To</span>
                          <BundleIdDisplay bundleId={event.toBundleId} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <InstallationPagination
                label="Installation history"
                limit={limit}
                offset={offset}
                pageLength={history.data.length}
                total={history.pagination.total}
                onOffsetChange={onOffsetChange}
              />
            </>
          ) : error ? (
            <div className="p-5 pt-0">
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>Installation history unavailable</AlertTitle>
                <AlertDescription>
                  {error instanceof Error
                    ? error.message
                    : "Failed to load installation history."}
                </AlertDescription>
              </Alert>
            </div>
          ) : (
            <div className="p-5 pt-0 text-sm text-muted-foreground">
              No history is available for this installation.
            </div>
          )
        ) : (
          <div className="p-5 pt-0 text-sm text-muted-foreground">
            Choose an installation to inspect its update history.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
