import { Link } from "@tanstack/react-router";
import { Search, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isAnalyticsQueryEnabled } from "@/lib/analytics-api";
import {
  type InstallationSearchRow,
  useInstallationSearchQuery,
} from "@/lib/api";

import { useAnalyticsCapability } from "./AnalyticsCapabilityContext";

const SEARCH_LIMIT = 20;

const identityLabel = (row: InstallationSearchRow): string =>
  row.userId ?? row.installId;

const platformLabel = (platform: InstallationSearchRow["platform"]): string =>
  platform === "ios" ? "iOS" : "Android";

export function InstallationSearch({
  initialQuery = "",
}: {
  readonly initialQuery?: string;
}) {
  const capability = useAnalyticsCapability();
  const normalizedInitialQuery = initialQuery.trim();
  const [draftQuery, setDraftQuery] = useState(normalizedInitialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(normalizedInitialQuery);
  const [offset, setOffset] = useState(0);
  const queryEnabled =
    isAnalyticsQueryEnabled(capability) && submittedQuery.length > 0;
  const { data, error, isLoading } = useInstallationSearchQuery(
    { query: submittedQuery, limit: SEARCH_LIMIT, offset },
    queryEnabled,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          <h2>Installation inspector</h2>
        </CardTitle>
        <CardDescription>
          Search by user ID or install ID to inspect its last known bundle.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <form
          className="max-w-2xl"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmittedQuery(draftQuery.trim());
            setOffset(0);
          }}
          role="search"
        >
          <label className="sr-only" htmlFor="analytics-installation-search">
            User ID or install ID
          </label>
          <InputGroup className="h-9">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              id="analytics-installation-search"
              aria-label="User ID or install ID"
              disabled={isLoading}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="Enter a user ID or install ID"
              type="search"
              value={draftQuery}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                disabled={isLoading}
                type="submit"
                variant="default"
              >
                Search
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>

        {!queryEnabled ? (
          <p className="text-sm text-muted-foreground">
            Enter a user ID or install ID to search received reports.
          </p>
        ) : isLoading ? (
          <div
            aria-label="Searching installations"
            className="flex flex-col gap-2"
          >
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Installation search unavailable</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : data && data.data.length > 0 ? (
          <div className="flex flex-col gap-3">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Installation</TableHead>
                  <TableHead>Last known bundle</TableHead>
                  <TableHead>Reported context</TableHead>
                  <TableHead className="text-right">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((row) => (
                  <InstallationResultRow
                    key={row.installId}
                    query={submittedQuery}
                    row={row}
                  />
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {offset + 1}–
                {Math.min(offset + data.data.length, data.pagination.total)} of{" "}
                {data.pagination.total}
              </p>
              <div className="flex gap-2">
                <Button
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - SEARCH_LIMIT))}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Previous
                </Button>
                <Button
                  disabled={offset + data.data.length >= data.pagination.total}
                  onClick={() => setOffset(offset + SEARCH_LIMIT)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No installations matched that search.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function InstallationResultRow({
  query,
  row,
}: {
  readonly query: string;
  readonly row: InstallationSearchRow;
}) {
  return (
    <TableRow>
      <TableCell className="max-w-64 whitespace-normal">
        <div className="flex flex-col gap-1">
          <span className="font-medium">{identityLabel(row)}</span>
          <code className="break-all text-muted-foreground">
            {row.installId}
          </code>
        </div>
      </TableCell>
      <TableCell className="max-w-64 whitespace-normal">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">Last known bundle</span>
          <code className="break-all">{row.lastKnownBundleId}</code>
        </div>
      </TableCell>
      <TableCell>
        {platformLabel(row.platform)} · {row.channel} · {row.appVersion}
      </TableCell>
      <TableCell className="text-right">
        <Link
          aria-label={`Open ${row.installId}`}
          className="font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2"
          search={{
            query,
            installId: row.installId,
            searchOffset: 0,
            historyOffset: 0,
          }}
          to="/installations"
        >
          Open
        </Link>
      </TableCell>
    </TableRow>
  );
}
