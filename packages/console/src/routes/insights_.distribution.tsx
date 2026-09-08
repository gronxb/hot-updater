import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowUpRight, RotateCw } from "lucide-react";

import { InsightsErrorAlert } from "@/components/features/insights/InsightsErrorAlert";
import { InsightsInfo } from "@/components/features/insights/InsightsInfo";
import { InsightsPageHeader } from "@/components/features/insights/InsightsPageHeader";
import { InsightsPeriodSelector } from "@/components/features/insights/InsightsPeriodSelector";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  validateDistributionSearch,
  validateInsightsSearch,
} from "@/lib/insights-search";
import { getAppUsageReportRpc } from "@/lib/insights-usage-rpc";

const PAGE_SIZE = 20;
export const Route = createFileRoute("/insights_/distribution")({
  component: DistributionPage,
  validateSearch: validateDistributionSearch,
});

function DistributionPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const input = {
    platform: search.platform ?? "all",
    channel: search.channel ?? "production",
    appVersion: search.appVersion,
    window: search.window ?? "24h",
  };
  const query = useQuery({
    queryKey: ["insights", "app-usage", input],
    queryFn: () => getAppUsageReportRpc({ data: input }),
    staleTime: 30_000,
  });
  const report = query.error ? undefined : query.data;
  const rows = (report?.bundleDistribution ?? []).filter(
    (row) => !search.version || row.appVersion === search.version,
  );
  const total = rows.reduce((sum, row) => sum + row.installations, 0);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(search.page ?? 1, pageCount);
  const versions = [
    ...new Set([
      ...(report?.versions.map((row) => row.name) ?? []),
      ...(search.version ? [search.version] : []),
    ]),
  ];
  const overviewSearch = validateInsightsSearch(search);
  const changeSearch = (next: Partial<typeof search>) =>
    void navigate({ search: { ...search, page: undefined, ...next } });

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <InsightsPageHeader view="distribution" overviewSearch={overviewSearch} />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 px-4 py-6 sm:p-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <Link
            to="/insights"
            search={overviewSearch}
            className={buttonVariants({
              variant: "ghost",
              className: "h-11 w-fit sm:h-9",
            })}
          >
            <ArrowLeft aria-hidden="true" data-icon="inline-start" />
            Back to overview
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="text-2xl font-semibold tracking-tight">
              Distribution
            </h2>
            <div className="flex items-center gap-3">
              <InsightsPeriodSelector
                window={input.window}
                onWindowChange={(window) => changeSearch({ window })}
              />
              <Button
                aria-label="Refresh distribution"
                variant="ghost"
                size="icon"
                className="size-11 sm:size-9"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                <RotateCw aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <Field className="w-full sm:w-64">
              <FieldLabel htmlFor="distribution-version">
                App version
              </FieldLabel>
              <Select
                items={Object.fromEntries([
                  ["all", "All versions"],
                  ...versions.map((version) => [`version:${version}`, version]),
                ])}
                value={search.version ? `version:${search.version}` : "all"}
                onValueChange={(value) => {
                  if (value !== null)
                    changeSearch({
                      version: value === "all" ? undefined : value.slice(8),
                    });
                }}
              >
                <SelectTrigger
                  id="distribution-version"
                  className="min-h-11 w-full sm:min-h-9"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All versions</SelectItem>
                    {versions.map((version) => (
                      <SelectItem value={`version:${version}`} key={version}>
                        {version}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <div
              className="flex min-h-9 flex-wrap items-center gap-2"
              aria-label="Distribution scope"
            >
              <Badge variant="outline" className="gap-1.5">
                {input.platform !== "all" ? (
                  <PlatformIcon
                    platform={input.platform}
                    className="size-3.5"
                  />
                ) : null}
                {input.platform === "all"
                  ? "All platforms"
                  : input.platform === "ios"
                    ? "iOS"
                    : "Android"}
              </Badge>
              <Badge variant="outline">{input.channel}</Badge>
              {input.appVersion ? (
                <Badge variant="outline">Reports from {input.appVersion}</Badge>
              ) : null}
            </div>
          </div>
          <Card
            aria-label="Bundles by app version"
            role="region"
            className="min-w-0"
          >
            <CardHeader className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Bundles by app version</CardTitle>
                <InsightsInfo label="How bundle distribution is counted">
                  Each installation contributes its latest matching report in
                  this period. Share is within its app version. Unknown bundle
                  means no deployment ID was observed for the reported file.
                  These counts describe reporting installations, not all
                  installed devices.
                </InsightsInfo>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {query.isPending ? (
                  <Skeleton className="h-9 w-16" />
                ) : (
                  <p className="text-3xl font-semibold tabular-nums">
                    {report
                      ? `${report.truncated ? "≥" : ""}${total.toLocaleString()}`
                      : "—"}
                  </p>
                )}
                <span className="text-sm text-muted-foreground">
                  Reporting installations
                </span>
              </div>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-4">
              {report?.truncated ? (
                <Alert>
                  <AlertTitle>Partial history</AlertTitle>
                  <AlertDescription>
                    Counts and shares reflect reports since{" "}
                    {new Date(report.sinceMs).toLocaleString("en", {
                      timeZone: "UTC",
                    })}{" "}
                    UTC. Choose a shorter period for a more complete view.
                  </AlertDescription>
                </Alert>
              ) : null}
              {query.isPending ? (
                <Skeleton
                  aria-label="Loading bundle distribution"
                  className="h-64"
                />
              ) : query.error ? (
                <div className="flex flex-col items-start gap-4">
                  <InsightsErrorAlert
                    error={query.error}
                    fallbackTitle="Distribution unavailable"
                  />
                  <Button
                    variant="outline"
                    onClick={() => void query.refetch()}
                  >
                    Retry distribution
                  </Button>
                </div>
              ) : rows.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No bundles reported</EmptyTitle>
                    <EmptyDescription>
                      Choose another version or period, or change the filters in
                      the overview.
                    </EmptyDescription>
                  </EmptyHeader>
                  <Button
                    variant="outline"
                    onClick={() => changeSearch({ version: undefined })}
                  >
                    Show all versions
                  </Button>
                </Empty>
              ) : (
                <div className="min-w-0">
                  <div
                    aria-hidden="true"
                    className="hidden grid-cols-[8rem_minmax(0,1fr)_7rem_7rem] gap-4 border-b px-3 pb-3 text-xs text-muted-foreground md:grid"
                  >
                    <span>App version</span>
                    <span>Bundle ID</span>
                    <span className="text-right">Active installations</span>
                    <span className="text-right">Version share</span>
                  </div>
                  <ul aria-label="Bundle distribution" className="divide-y">
                    {rows
                      .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
                      .map((row) => {
                        const versionTotal =
                          report?.versions.find(
                            (version) => version.name === row.appVersion,
                          )?.installations ?? 0;
                        const share =
                          versionTotal > 0
                            ? (row.installations / versionTotal) * 100
                            : 0;
                        return (
                          <li
                            key={JSON.stringify([
                              row.appVersion,
                              row.platform,
                              row.releaseId,
                            ])}
                            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 px-1 py-4 md:grid-cols-[8rem_minmax(0,1fr)_7rem_7rem] md:px-3"
                          >
                            <div className="flex min-w-0 flex-col gap-1">
                              <span
                                className="truncate text-sm font-medium"
                                title={row.appVersion}
                              >
                                {row.appVersion}
                              </span>
                              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <PlatformIcon
                                  platform={row.platform}
                                  className="size-3.5"
                                />
                                {row.platform === "ios" ? "iOS" : "Android"}
                              </span>
                            </div>
                            <div className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-auto">
                              {row.releaseId ? (
                                <Link
                                  to="/"
                                  search={{ releaseId: row.releaseId }}
                                  aria-label={`Review bundle ${row.releaseId} for app version ${row.appVersion}`}
                                  className="flex min-h-11 min-w-0 items-center gap-2 text-xs underline-offset-4 hover:underline md:min-h-9"
                                >
                                  <span className="break-all font-mono">
                                    {row.releaseId}
                                  </span>
                                  <ArrowUpRight
                                    aria-hidden="true"
                                    className="size-3.5 shrink-0"
                                  />
                                </Link>
                              ) : (
                                <span className="text-sm text-muted-foreground">
                                  Unknown bundle
                                </span>
                              )}
                            </div>
                            <div className="col-start-2 row-start-1 text-right md:col-auto md:row-auto">
                              <span className="text-sm font-medium tabular-nums">
                                {row.installations.toLocaleString()}
                              </span>
                              <span className="ml-1 text-xs text-muted-foreground md:sr-only">
                                active
                              </span>
                              <p className="mt-1 text-xs tabular-nums text-muted-foreground md:hidden">
                                {share.toFixed(1)}% of version
                              </p>
                            </div>
                            <div className="hidden flex-col gap-2 md:flex">
                              <span className="text-right text-sm tabular-nums">
                                {share.toFixed(1)}%
                              </span>
                              <Progress
                                aria-label={`${row.releaseId ?? "Unknown bundle"} share in ${row.appVersion} on ${row.platform}`}
                                value={share}
                              />
                            </div>
                          </li>
                        );
                      })}
                  </ul>
                </div>
              )}
            </CardContent>
            {report && rows.length > 0 ? (
              <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <p className="text-xs tabular-nums text-muted-foreground">
                  {(page - 1) * PAGE_SIZE + 1}–
                  {Math.min(page * PAGE_SIZE, rows.length)} of {rows.length}
                </p>
                <nav aria-label="Distribution pages" className="flex gap-2">
                  <Button
                    variant="outline"
                    className="h-11 sm:h-9"
                    disabled={page <= 1}
                    onClick={() => changeSearch({ page: page - 1 })}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 sm:h-9"
                    disabled={page >= pageCount}
                    onClick={() => changeSearch({ page: page + 1 })}
                  >
                    Next
                  </Button>
                </nav>
              </CardFooter>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}
