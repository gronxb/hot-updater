import type { ChannelRow, ReleaseRow } from "@hot-updater/plugin-core";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Filter,
  RotateCcw,
  Tags,
  X,
} from "lucide-react";
import { useState } from "react";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { ChannelBadge } from "@/components/ChannelBadge";
import { EnabledStatusIcon } from "@/components/EnabledStatusIcon";
import { ChannelManagementDialog } from "@/components/features/channels/ChannelManagementDialog";
import { ReleaseEditorSheet } from "@/components/features/releases/ReleaseEditorSheet";
import { ReleaseStateBadge } from "@/components/features/releases/ReleaseStateBadge";
import { PlatformIcon } from "@/components/PlatformIcon";
import { RolloutPercentageBadge } from "@/components/RolloutPercentageBadge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  useBundleChildCountsQuery,
  useChannelsQuery,
  useReleasesQuery,
} from "@/lib/api";

import {
  type ReleaseSearch,
  updateReleaseFilters,
  validateReleaseSearch,
} from "./-releases-search";

const PAGE_SIZE = 20;
const platformFilterItems = [
  { label: "All Platforms", value: "all" },
  { label: "iOS", value: "ios" },
  { label: "Android", value: "android" },
];
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export const Route = createFileRoute("/")({
  component: BundlesPage,
  validateSearch: validateReleaseSearch,
});

const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;

function BundleFilterToolbar({
  channels,
  onChange,
  onClear,
  onManageChannels,
  search,
}: {
  channels: readonly ChannelRow[];
  onChange: (filters: Partial<ReleaseSearch>) => void;
  onClear: () => void;
  onManageChannels: () => void;
  search: ReleaseSearch;
}) {
  const hasFilters = Boolean(
    search.bundleId ||
    search.channelId ||
    search.enabled !== undefined ||
    search.platform ||
    search.targetAppVersion,
  );
  const channelFilterItems = [
    { label: "All Channels", value: "all" },
    ...channels.map((channel) => ({
      label: channel.name,
      value: channel.id,
    })),
  ];

  return (
    <header className="sticky top-0 z-20 flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-3 sm:h-12 sm:flex-nowrap sm:bg-card/85 sm:px-4 sm:py-0 sm:backdrop-blur-sm">
      <SidebarTrigger className="-ml-1" />
      <h1 className="sr-only">Bundles</h1>
      <div className="ml-1 flex items-center gap-1.5 text-muted-foreground sm:ml-2">
        <Filter className="size-3.5" />
        <span className="text-xs font-medium">Filters</span>
      </div>
      <Select
        items={platformFilterItems}
        onValueChange={(value) =>
          onChange({
            platform:
              value === "all" ? undefined : (value as "ios" | "android"),
          })
        }
        value={search.platform ?? "all"}
      >
        <SelectTrigger
          aria-label="Platform"
          className="h-8 w-[calc(50%-0.25rem)] min-w-[132px] text-xs sm:w-[140px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All Platforms</SelectItem>
            <SelectItem value="ios">iOS</SelectItem>
            <SelectItem value="android">Android</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select
        items={channelFilterItems}
        onValueChange={(value) =>
          onChange({
            channelId: value === null || value === "all" ? undefined : value,
          })
        }
        value={search.channelId ?? "all"}
      >
        <SelectTrigger
          aria-label="Channel"
          className="h-8 w-[calc(50%-0.25rem)] min-w-[132px] text-xs sm:w-[140px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All Channels</SelectItem>
            {channels.map((channel) => (
              <SelectItem key={channel.id} value={channel.id}>
                {channel.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Button
        aria-label="Manage channels"
        onClick={onManageChannels}
        size="icon-sm"
        title="Manage channels"
        variant="outline"
      >
        <Tags />
      </Button>
      {search.bundleId ? (
        <Badge className="max-w-48 gap-1" variant="secondary">
          Bundle {shortId(search.bundleId)}
          <button
            aria-label="Clear Bundle filter"
            className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onChange({ bundleId: undefined })}
            type="button"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ) : null}
      {hasFilters ? (
        <Button
          className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground sm:ml-auto"
          onClick={onClear}
          size="sm"
          variant="ghost"
        >
          <X data-icon="inline-start" />
          Clear
        </Button>
      ) : null}
    </header>
  );
}

function BundleEntry({
  onOpen,
  release,
}: {
  onOpen: () => void;
  release: ReleaseRow;
}) {
  const bundleLabel = release.bundle_id
    ? `bundle ${release.bundle_id}`
    : "the built-in app deployment";

  return (
    <div className="flex min-w-[220px] flex-col items-start gap-1.5">
      <button
        aria-label={`Open details for ${bundleLabel}`}
        className="min-w-0 rounded-sm text-left font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
        title={release.bundle_id ?? release.id}
        type="button"
      >
        {release.bundle_id ? (
          <BundleIdDisplay bundleId={release.bundle_id} />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm">
            <RotateCcw className="size-3.5" /> Built-in app
          </span>
        )}
      </button>
      <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span>rev {release.revision}</span>
        <Badge variant="outline">{release.operation}</Badge>
      </span>
    </div>
  );
}

function BundlesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const isMobile = useIsMobile();
  const [channelsOpen, setChannelsOpen] = useState(false);
  const releasesQuery = useReleasesQuery({
    afterReleaseId: search.afterReleaseId,
    beforeReleaseId: search.beforeReleaseId,
    bundleId: search.bundleId,
    channelId: search.channelId,
    enabled: search.enabled,
    limit: PAGE_SIZE,
    page: search.page,
    platform: search.platform,
    targetAppVersion: search.targetAppVersion,
  });
  const channelsQuery = useChannelsQuery();
  const channels = channelsQuery.data ?? [];
  const releases = releasesQuery.data?.data ?? [];
  const bundleIds = Array.from(
    new Set(
      releases.flatMap((release) =>
        release.bundle_id ? [release.bundle_id] : [],
      ),
    ),
  );
  const patchCountsQuery = useBundleChildCountsQuery(bundleIds);
  const patchCountsByBundleId = patchCountsQuery.data ?? {};
  const pagination = releasesQuery.data?.pagination;
  const channelNames = new Map(
    channels.map((channel) => [channel.id, channel.name]),
  );

  const go = (nextSearch: ReleaseSearch, resetScroll = true) =>
    void navigate({ resetScroll, search: nextSearch, to: "/" });
  const changeFilters = (filters: Partial<ReleaseSearch>) =>
    go(updateReleaseFilters(search, filters));
  const currentPage = pagination?.currentPage ?? 1;
  const previousPage = currentPage - 1;
  const firstReleaseId = releases[0]?.id;
  const lastReleaseId = releases.at(-1)?.id;
  const previousSearch: ReleaseSearch | null =
    pagination?.hasPreviousPage && firstReleaseId
      ? {
          ...search,
          afterReleaseId: firstReleaseId,
          beforeReleaseId: undefined,
          page: previousPage > 1 ? previousPage : undefined,
          releaseId: undefined,
        }
      : null;
  const nextSearch: ReleaseSearch | null =
    pagination?.hasNextPage && lastReleaseId
      ? {
          ...search,
          afterReleaseId: undefined,
          beforeReleaseId: lastReleaseId,
          page: currentPage + 1,
          releaseId: undefined,
        }
      : null;

  return (
    <div className="flex h-svh min-h-0 min-w-0 flex-col bg-muted/5">
      <BundleFilterToolbar
        channels={channels}
        onChange={changeFilters}
        onClear={() => go({})}
        onManageChannels={() => setChannelsOpen(true)}
        search={search}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 p-3 sm:p-6">
        {releasesQuery.isError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Bundles could not be loaded</AlertTitle>
            <AlertDescription>{releasesQuery.error.message}</AlertDescription>
          </Alert>
        ) : (
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border bg-card shadow-sm [&_[data-slot=table-container]]:h-full [&_[data-slot=table-container]]:overflow-auto">
            {isMobile ? (
              <div className="h-full overflow-y-auto">
                {releasesQuery.isPending ? (
                  <div className="flex flex-col gap-3 p-4">
                    {Array.from({ length: 5 }, (_, index) => (
                      <Skeleton className="h-44 w-full" key={index} />
                    ))}
                  </div>
                ) : releases.length ? (
                  releases.map((release) => {
                    const channelName =
                      channelNames.get(release.channel_id) ??
                      release.channel_id;
                    const patchCount = release.bundle_id
                      ? patchCountsByBundleId[release.bundle_id]
                      : 0;

                    return (
                      <article
                        className="flex flex-col gap-4 border-b p-4 last:border-b-0"
                        key={release.id}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <BundleEntry
                            onOpen={() =>
                              go({ ...search, releaseId: release.id }, false)
                            }
                            release={release}
                          />
                          <ChannelBadge
                            channel={channelName}
                            className="shrink-0"
                          />
                        </div>
                        <dl className="grid grid-cols-2 gap-3 text-xs">
                          <div className="rounded-md bg-muted/40 p-3">
                            <dt className="text-muted-foreground">Platform</dt>
                            <dd className="mt-1 flex items-center gap-2 font-medium">
                              <PlatformIcon
                                className="size-4"
                                platform={release.platform}
                              />
                              {release.platform === "ios" ? "iOS" : "Android"}
                            </dd>
                          </div>
                          <div className="rounded-md bg-muted/40 p-3">
                            <dt className="text-muted-foreground">Created</dt>
                            <dd className="mt-1 tabular-nums">
                              {dateFormatter.format(release.created_at_ms)}
                            </dd>
                          </div>
                          <div className="rounded-md bg-muted/40 p-3">
                            <dt className="text-muted-foreground">Rollout</dt>
                            <dd className="mt-1">
                              <RolloutPercentageBadge
                                percentage={release.rollout_cohort_count / 10}
                              />
                            </dd>
                          </div>
                          <div className="rounded-md bg-muted/40 p-3">
                            <dt className="text-muted-foreground">Patches</dt>
                            <dd className="mt-1">
                              {patchCount === undefined
                                ? "Checking"
                                : patchCount > 0
                                  ? `${patchCount} ${
                                      patchCount === 1 ? "patch" : "patches"
                                    }`
                                  : "—"}
                            </dd>
                          </div>
                          <div className="col-span-2 flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3">
                            <ReleaseStateBadge release={release} />
                            {release.should_force_update ? (
                              <Badge variant="secondary">Force update</Badge>
                            ) : null}
                          </div>
                          <div className="col-span-2 grid gap-2 rounded-md border bg-background/80 p-3">
                            <div className="flex items-start justify-between gap-3">
                              <dt className="text-muted-foreground">Target</dt>
                              <dd className="min-w-0 truncate text-right font-mono">
                                {release.target_app_version ??
                                  release.fingerprint_hash ??
                                  "—"}
                              </dd>
                            </div>
                            <div className="flex items-start justify-between gap-3">
                              <dt className="text-muted-foreground">Message</dt>
                              <dd className="min-w-0 text-right text-foreground">
                                {release.message || "—"}
                              </dd>
                            </div>
                          </div>
                        </dl>
                      </article>
                    );
                  })
                ) : (
                  <p className="p-8 text-center text-sm text-muted-foreground">
                    {search.bundleId ||
                    search.channelId ||
                    search.enabled !== undefined ||
                    search.platform ||
                    search.targetAppVersion
                      ? "No bundles match these filters."
                      : "No bundles yet. Deploy a bundle to see it here."}
                  </p>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                  <TableRow>
                    <TableHead>Bundle ID</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead>Patches</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Enabled</TableHead>
                    <TableHead>Force Update</TableHead>
                    <TableHead>Rollout</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {releasesQuery.isPending
                    ? Array.from({ length: 7 }, (_, index) => (
                        <TableRow key={index}>
                          <TableCell colSpan={10}>
                            <Skeleton className="h-8 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    : releases.map((release) => (
                        <TableRow
                          aria-label={`Open bundle ${release.bundle_id ?? release.id}`}
                          className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          data-state={
                            search.releaseId === release.id
                              ? "selected"
                              : undefined
                          }
                          key={release.id}
                          onClick={(event) => {
                            if (
                              event.target instanceof Element &&
                              event.target.closest(
                                "button, a, input, select, textarea",
                              )
                            ) {
                              return;
                            }
                            go({ ...search, releaseId: release.id }, false);
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.target !== event.currentTarget ||
                              (event.key !== "Enter" && event.key !== " ")
                            ) {
                              return;
                            }
                            event.preventDefault();
                            go({ ...search, releaseId: release.id }, false);
                          }}
                          tabIndex={0}
                        >
                          <TableCell>
                            <BundleEntry
                              onOpen={() =>
                                go({ ...search, releaseId: release.id }, false)
                              }
                              release={release}
                            />
                          </TableCell>
                          <TableCell>
                            <ChannelBadge
                              channel={
                                channelNames.get(release.channel_id) ??
                                release.channel_id
                              }
                            />
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            <span className="flex items-center gap-2">
                              <PlatformIcon
                                className="size-4"
                                platform={release.platform}
                              />
                              {release.platform === "ios" ? "iOS" : "Android"}
                            </span>
                          </TableCell>
                          <TableCell>
                            {release.bundle_id &&
                            patchCountsByBundleId[release.bundle_id] ===
                              undefined ? (
                              <span className="text-sm text-muted-foreground">
                                Checking
                              </span>
                            ) : release.bundle_id &&
                              patchCountsByBundleId[release.bundle_id]! > 0 ? (
                              <Badge variant="secondary">
                                {patchCountsByBundleId[release.bundle_id]}{" "}
                                {patchCountsByBundleId[release.bundle_id] === 1
                                  ? "patch"
                                  : "patches"}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell
                            className="max-w-44 truncate font-mono text-xs"
                            title={
                              release.target_app_version ??
                              release.fingerprint_hash ??
                              undefined
                            }
                          >
                            {release.target_app_version ??
                              release.fingerprint_hash ??
                              "—"}
                          </TableCell>
                          <TableCell>
                            <EnabledStatusIcon enabled={release.enabled} />
                            <span className="sr-only">
                              {release.enabled ? "Enabled" : "Disabled"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <EnabledStatusIcon
                              enabled={release.should_force_update}
                              falseIcon="minus"
                            />
                            <span className="sr-only">
                              {release.should_force_update
                                ? "Force update"
                                : "Optional update"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <RolloutPercentageBadge
                              percentage={release.rollout_cohort_count / 10}
                            />
                          </TableCell>
                          <TableCell
                            className="max-w-52 truncate text-xs text-muted-foreground"
                            title={release.message ?? undefined}
                          >
                            {release.message || "—"}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {dateFormatter.format(release.created_at_ms)}
                          </TableCell>
                        </TableRow>
                      ))}
                  {!releasesQuery.isPending && releases.length === 0 ? (
                    <TableRow>
                      <TableCell
                        className="h-40 text-center text-muted-foreground"
                        colSpan={10}
                      >
                        {search.bundleId ||
                        search.channelId ||
                        search.enabled !== undefined ||
                        search.platform ||
                        search.targetAppVersion
                          ? "No bundles match these filters."
                          : "No bundles yet. Deploy a bundle to see it here."}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            )}
          </div>
        )}

        {!releasesQuery.isError && !releasesQuery.isPending ? (
          <nav
            aria-label="Bundle pagination"
            className="flex items-center justify-between gap-3"
          >
            <p className="text-xs text-muted-foreground">
              Page {pagination?.currentPage ?? 1}
            </p>
            <div className="flex gap-2">
              {previousSearch ? (
                <Link
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                  search={previousSearch}
                  to="/"
                >
                  <ChevronLeft data-icon="inline-start" />
                  Previous
                </Link>
              ) : (
                <Button disabled size="sm" variant="outline">
                  <ChevronLeft data-icon="inline-start" />
                  Previous
                </Button>
              )}
              {nextSearch ? (
                <Link
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                  search={nextSearch}
                  to="/"
                >
                  Next
                  <ChevronRight data-icon="inline-end" />
                </Link>
              ) : (
                <Button disabled size="sm" variant="outline">
                  Next
                  <ChevronRight data-icon="inline-end" />
                </Button>
              )}
            </div>
          </nav>
        ) : null}
      </div>

      <ReleaseEditorSheet
        channels={channels}
        onOpenChange={(open) =>
          !open && go({ ...search, releaseId: undefined }, false)
        }
        open={Boolean(search.releaseId)}
        releaseId={search.releaseId ?? ""}
      />
      <ChannelManagementDialog
        onOpenChange={setChannelsOpen}
        open={channelsOpen}
      />
    </div>
  );
}
